/** Keyword retrieval: BM25 over docs.jsonl records (spec/50 — normative for
 * conformance). Depends on nothing beyond T1, so search works everywhere. */
import { cmpStr } from "../core/canonical";
import { pySplitWhitespace } from "../core/pyfmt";
import type { DocRecord } from "../compile/t1";

// Python [^\W_]+ with re.UNICODE: word characters minus the underscore —
// letters and numbers (\p{N} covers Nd/Nl/No like str.isalnum()).
const TOKEN = /[\p{L}\p{N}]+/gu;
// An identifier is also a token of its own: a run of word tokens joined by single '-' or
// '_' (SAI-PIPELESS-V, identity_authorized_bc_id) is emitted whole after its parts, so a
// query naming it matches it as itself, not only the common words it is built from.
const COMPOUND = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu;
export const K1 = 1.2;
export const B = 0.75;
export const SNIPPET_WINDOW = 240;
// How far back from the first match the snippet looks for the head of the log entry
// ("* " at column 0) that contains it, so a journal hit is shown from its entry, not from
// wherever the word fell.
export const ENTRY_LOOKBACK = 4000;
// a column-0 list item opens a log entry (journal days, changelogs)
const ENTRY_HEAD = /^\* /gm;
// Closed-class English function words, dropped from the QUERY only (spec/50): documents are
// indexed whole, so a query that is a sentence stops matching every doc on "the" and "and",
// and its snippet lands on a content word. Not a frequency threshold — a fixed list, the
// same in both engines. The brain is English (its contract enforces it), so one language.
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a an the and or but nor of to in on at for with by from as is are was were be been being
it its this that these those there here not no do does did done have has had having i me
my we us our you your he him his she her they them their what which who whom whose when
where why how then than so if into onto over under about after before between while
also just very can could will would shall should may might must`.split(/\s+/),
);

/** The retriever that produced a hit (spec/50; under fusion, the
 * highest-contributing one). `title` is the deterministic navigational match that
 * guarantees a page the query names surfaces in every mode. */
export type HitSource = "keyword" | "semantic" | "graph" | "title";

export interface SearchHit {
  description: string | null;
  path: string;
  score: number;
  snippet: string | null;
  source: HitSource;
  title: string;
}

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  return [...(lowered.match(TOKEN) ?? []), ...(lowered.match(COMPOUND) ?? [])];
}

/** The query's tokens minus stopwords and minus the numeric fragments of its compound
 * identifiers — what the keyword retrievers match on. `2026-09-09-soniox-spec.md` must not
 * match every day of that month on `2026` and `09`; the compound itself still matches
 * whole, and `SHAI-127` keeps `shai` and `shai-127` (a bare `40002` is not a fragment). */
export function queryTokens(query: string): string[] {
  const numericParts = new Set<string>();
  for (const compound of query.toLowerCase().match(COMPOUND) ?? []) {
    for (const part of compound.split(/[-_]/)) if (/^\d+$/.test(part)) numericParts.add(part);
  }
  return tokenize(query).filter((t) => !STOPWORDS.has(t) && !numericParts.has(t));
}

function searchable(record: DocRecord, unit: string): string {
  const title = record.title;
  const description = record.description || "";
  return [title, title, title, description, description, unit].join("\n");
}

/** The BM25 units of a record: a log-shaped doc (two or more column-0 `* ` entries) is
 * one unit per entry, anything else one unit — so a journal day with sixty entries is
 * sixty short documents to the ranker, not one huge one, and the entry ABOUT a phrase
 * outranks the entry that merely cites it (spec/50 "Keyword units"). Mirrors keyword._units. */
function units(record: DocRecord): string[] {
  const text = record.text;
  const starts = [...text.matchAll(ENTRY_HEAD)].map((m) => m.index!);
  if (starts.length < 2) return [text];
  return starts.map((start, i) => text.slice(start, i + 1 < starts.length ? starts[i + 1]! : text.length));
}

export function search(records: DocRecord[], query: string, limit = 8): SearchHit[] {
  const corpus = records.filter((r) => !r.reserved);
  if (corpus.length === 0) return [];

  const unitList: Array<[DocRecord, string]> = [];
  for (const r of corpus) for (const u of units(r)) unitList.push([r, u]);
  const termFreqs = unitList.map(([r, u]) => {
    const tf = new Map<string, number>();
    for (const token of tokenize(searchable(r, u))) tf.set(token, (tf.get(token) ?? 0) + 1);
    return tf;
  });
  const unitLengths = termFreqs.map((tf) => {
    let total = 0;
    for (const count of tf.values()) total += count;
    return total;
  });
  const avgLength = unitLengths.reduce((a, b) => a + b, 0) / unitLengths.length;

  const queryTerms = queryTokens(query);
  if (queryTerms.length === 0 || avgLength === 0) return [];

  const unitCount = unitList.length;
  const unitFreq = new Map<string, number>();
  for (const t of new Set(queryTerms)) {
    unitFreq.set(t, termFreqs.filter((tf) => (tf.get(t) ?? 0) > 0).length);
  }

  const best = new Map<string, SearchHit>(); // path -> the record's best-scoring unit as a hit
  for (let i = 0; i < unitList.length; i++) {
    const [record, unit] = unitList[i]!;
    const tfMap = termFreqs[i]!;
    const ul = unitLengths[i]!;
    let score = 0;
    for (const term of queryTerms) {
      const tf = tfMap.get(term) ?? 0;
      if (tf === 0) continue;
      const df = unitFreq.get(term)!;
      const idf = Math.log((unitCount - df + 0.5) / (df + 0.5) + 1);
      score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * ul) / avgLength));
    }
    if (score <= 0) continue;
    const current = best.get(record.path);
    if (current === undefined || score > current.score) {
      best.set(record.path, {
        description: record.description,
        path: record.path,
        score: round6(score),
        snippet: snippet(unit, queryTerms),
        source: "keyword",
        title: record.title,
      });
    }
  }

  const hits = [...best.values()];
  hits.sort((a, b) => b.score - a.score || cmpStr(a.path, b.path));
  return hits.slice(0, limit);
}

/** Python round(score, 6). (Ties-to-even differences at the 7th decimal are
 * unobservable here — conformance compares result sets, not scores.) */
function round6(x: number): number {
  return Number(x.toFixed(6));
}

function snippet(text: string, queryTerms: string[]): string | null {
  const lowered = text.toLowerCase();
  let first = -1;
  for (const t of queryTerms) {
    const i = lowered.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first === -1) return null;
  // a log-shaped doc: open the snippet at the head of the entry the match sits in
  // (Python text.rfind("\n* ", max(0, first - ENTRY_LOOKBACK), first + 1))
  const lo = Math.max(0, first - ENTRY_LOOKBACK);
  let head = first + 1 - 3 < 0 ? -1 : text.lastIndexOf("\n* ", first + 1 - 3);
  if (head < lo) head = -1;
  let start: number;
  if (head !== -1) start = head + 1;
  else if (text.startsWith("* ") && first < ENTRY_LOOKBACK) start = 0;
  else start = Math.max(0, first - 60);
  return pySplitWhitespace(text.slice(start, start + SNIPPET_WINDOW)).join(" ");
}

/** Does a TITLE token account for a query token? Exact, or a short prefix-stem so a
 * simple inflection reaches its stem ('agents'→'agent', 'connects'→'connect') without
 * stemming machinery — bounded to a ±2 length prefix so it never over-fires (e.g.
 * 'auth' does NOT swallow 'authentication'). Byte-parallel with query/keyword.py. */
function covers(queryToken: string, titleToken: string): boolean {
  if (queryToken === titleToken) return true;
  if (queryToken.length >= 4 && titleToken.length >= 4 && Math.abs(queryToken.length - titleToken.length) <= 2) {
    return queryToken.startsWith(titleToken) || titleToken.startsWith(queryToken);
  }
  return false;
}

/** Docs whose TITLE the query names — a deterministic T1 navigational signal so typing
 * an article's name always finds that article (in every mode). A doc qualifies only when
 * EVERY query token is covered by some title token (exact or short prefix-stem), so
 * 'cli'→'CLI reference' and 'agents'→'Agent integrations' match while an unrelated word
 * does not. Ranked exact-title first, then the tightest (fewest extra title tokens),
 * then path — deterministic across engines. */
export function titleSearch(records: DocRecord[], query: string, limit = 8): SearchHit[] {
  const qTokens = queryTokens(query);
  if (qTokens.length === 0) return [];
  const qUnique = [...new Set(qTokens)];
  const scored: Array<{ exact: number; ntok: number; record: DocRecord }> = [];
  for (const record of records) {
    if (record.reserved) continue;
    const tTokens = tokenize(record.title);
    if (tTokens.length === 0) continue;
    if (!qUnique.every((q) => tTokens.some((t) => covers(q, t)))) continue;
    const exact = tTokens.length === qTokens.length && tTokens.every((t, i) => t === qTokens[i]) ? 1 : 0;
    scored.push({ exact, ntok: tTokens.length, record });
  }
  scored.sort((a, b) => b.exact - a.exact || a.ntok - b.ntok || cmpStr(a.record.path, b.record.path));
  return scored.slice(0, limit).map(({ exact, record }) => ({
    description: record.description,
    path: record.path,
    score: round6(1.0 + exact), // 2.0 for an exact title, 1.0 otherwise
    snippet: null,
    source: "title" as HitSource,
    title: record.title,
  }));
}
