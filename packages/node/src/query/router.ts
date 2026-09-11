/** One search surface, four strategies (spec/30 + spec/50): keyword always,
 * semantic when T2 is fresh, RRF fusion under auto, honest degradation markers. */
import type { DocRecord, Graph } from "../compile/t1";
import { cmpStr } from "../core/canonical";
import { linkWalkSearch } from "../kg";
import { search as keywordSearch, titleSearch, type SearchHit } from "./keyword";

export const KNOWN_MODES = ["auto", "keyword", "semantic", "graph"] as const;
export const RRF_K = 60; // spec/30: reciprocal rank fusion constant
// The strongest few title matches a mode may inject when its own retrieval missed the
// named page — capped so a common word can't flood the answer with same-topic pages.
export const TITLE_INJECT_CAP = 3;

// auto may consult the entity graph, but only for relation-shaped queries — the
// small deterministic heuristic that keeps "what connects to X" honest without
// dragging graph noise into every keyword lookup (spec/40).
export const RELATIONAL_HINTS = ["relate", "connect", "between"] as const;

export type SemanticFn = (query: string, limit: number) => Promise<SearchHit[]> | SearchHit[];
export type GraphFn = (query: string, limit: number) => SearchHit[];

export interface SearchBody {
  hits: SearchHit[];
  used_modes: string[];
  degraded_from: string | null;
}

/** Unknown modes fall back to auto — never an error (spec/50). */
export function resolveMode(mode: unknown): string {
  const resolved = String(mode || "auto");
  return (KNOWN_MODES as readonly string[]).includes(resolved) ? resolved : "auto";
}

/** A query auto should widen with graph results: it asks about connections
 * ('relate'/'related', 'connect'/'connects', 'between'). Substring match so the
 * stems catch their inflections; deterministic and conservative (spec/40). */
export function isRelational(query: string): boolean {
  const lowered = String(query ?? "").toLowerCase();
  return RELATIONAL_HINTS.some((hint) => lowered.includes(hint));
}

/** Python round(x, 6) — see query/keyword.ts. */
function round6(x: number): number {
  return Number(x.toFixed(6));
}

/** RRF (k=60) across retrievers, deduped by document. A hit keeps the fields
 * of the retriever contributing its best rank — that retriever is its source. */
export function rrfFuse(rankings: Record<string, SearchHit[]>, limit: number): SearchHit[] {
  const scores = new Map<string, number>();
  const best = new Map<string, [number, SearchHit]>(); // path -> (best rank, that retriever's hit)
  for (const hits of Object.values(rankings)) {
    for (let i = 0; i < hits.length; i++) {
      const rank = i + 1;
      const hit = hits[i]!;
      scores.set(hit.path, (scores.get(hit.path) ?? 0.0) + 1.0 / (RRF_K + rank));
      const current = best.get(hit.path);
      if (current === undefined || rank < current[0]) best.set(hit.path, [rank, hit]);
    }
  }

  const fused: SearchHit[] = [];
  const ordered = [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)! || cmpStr(a, b));
  for (const path of ordered) {
    const hit = { ...best.get(path)![1] };
    hit.score = round6(scores.get(path)!);
    fused.push(hit);
  }
  return fused.slice(0, limit);
}

/** Guarantee the strongest TITLE matches are present: inject any the mode's own
 * retrieval missed at the FRONT (you typed a page's name — that page should appear),
 * capped so a common word can't flood the answer. A NO-OP when nothing is missing, so a
 * result the retriever already found is returned unchanged. Mirrors router.ensure_titles. */
export function ensureTitles(hits: SearchHit[], titleHits: SearchHit[], limit: number): SearchHit[] {
  if (titleHits.length === 0) return hits.slice(0, limit);
  const present = new Set(hits.map((h) => h.path));
  const missing = titleHits.filter((h) => !present.has(h.path)).slice(0, TITLE_INJECT_CAP);
  if (missing.length === 0) return hits.slice(0, limit);
  return [...missing, ...hits].slice(0, limit);
}

/** [keyword query, semantic query, title query] — spec/50 two-input search.
 *
 * `terms` (identifiers, verbatim) feed the keyword engine and `situation` (the
 * episode in sentences) feeds the semantic engine; a bare `query` feeds both, the
 * legacy single-string shape. The title query is everything, so a named page is
 * injected whichever half named it. Mirrors router.split_query. */
export function splitQuery(
  query: string | null | undefined,
  terms: string[] | null | undefined,
  situation: string | null | undefined,
): [string, string, string] {
  if ((terms === null || terms === undefined) && (situation === null || situation === undefined)) {
    const q = String(query || "");
    return [q, q, q];
  }
  // The semantic engine sees only the situation (an identifier list embeds to nothing
  // useful); the keyword engine sees the terms AND the situation — a sentence costs BM25
  // only function-word noise, and its nouns still match. Mirrors router.split_query.
  const ids = (terms ?? [])
    .map((t) => String(t))
    .filter((t) => t.trim() !== "")
    .join(" ")
    .trim();
  const sem = String(situation || "").trim();
  const both = [ids, sem].filter((part) => part !== "").join(" ");
  return [both, sem, both];
}

/** The spec/50 response body: {"hits", "used_modes", "degraded_from"}.
 *
 * Two inputs, two engines: `situation` alone goes to the semantic retriever, the
 * keyword retriever gets `terms` plus the situation (a legacy `query` goes to both). `semanticFn(query, limit)` runs
 * the vector retriever; callers wire it to query/vectors.semanticSearch. Any semantic
 * failure degrades to keyword — a missing tier downgrades the answer, never errors
 * the call. An empty half simply contributes no ranking: terms alone is a keyword
 * search, a situation alone is a semantic one. */
export async function runSearch(
  records: DocRecord[],
  tiers: Record<string, unknown>,
  query: string | null | undefined,
  mode: unknown = "auto",
  limit = 8,
  semanticFn: SemanticFn | null = null,
  graphFn: GraphFn | null = null,
  linkGraph: Graph | null = null,
  terms: string[] | null = null,
  situation: string | null = null,
): Promise<SearchBody> {
  const resolved = resolveMode(mode);
  const t2Fresh = tiers["t2"] === "fresh" && semanticFn !== null;
  const t3On = graphFn !== null;
  const [kwQuery, semQuery, titleQuery] = splitQuery(query, terms, situation);
  // the keyword engine's fallback text when it has no terms of its own
  const kwOrSem = kwQuery || semQuery;

  if (resolved === "keyword") {
    return body(keywordSearch(records, kwOrSem, limit), ["keyword"], null);
  }
  if (resolved === "graph") {
    if (t3On) return body(graphFn!(semQuery || kwQuery, limit), ["graph"], null);
    // T3 absent: degrade to a T1 link-walk over keyword hits (spec/40)
    const hits = linkGraph
      ? linkWalkSearch(linkGraph, records, kwOrSem, limit)
      : keywordSearch(records, kwOrSem, limit);
    return body(hits, ["keyword"], "graph");
  }

  let semanticHits: SearchHit[] | null = null;
  if (t2Fresh && semQuery !== "") {
    try {
      semanticHits = await semanticFn!(semQuery, limit);
    } catch {
      semanticHits = null; // degrade below; T2 trouble must never error a search
    }
  }

  // A doc the query NAMES by title is surfaced in every retrieval mode — vectors miss
  // short/technical title words, and RRF can bury a strong keyword title hit, so this
  // guarantees the named page never goes missing (only injected when actually absent).
  const titleHits = titleSearch(records, titleQuery, limit);

  if (resolved === "semantic") {
    if (semanticHits === null) {
      return body(keywordSearch(records, semQuery || kwQuery, limit), ["keyword"], "semantic");
    }
    return body(ensureTitles(semanticHits, titleHits, limit), ["semantic"], null);
  }

  // auto: fuse whatever is available (spec/30: RRF k=60, dedupe by document).
  // The entity graph joins only for relation-shaped queries (spec/40).
  const rankings: Record<string, SearchHit[]> = { keyword: keywordSearch(records, kwOrSem, limit) };
  if (semanticHits !== null) rankings["semantic"] = semanticHits;
  if (t3On && isRelational(semQuery || kwQuery)) rankings["graph"] = graphFn!(semQuery || kwQuery, limit);

  const degradedFrom = semanticHits === null && semQuery !== "" ? "semantic" : null;
  const names = Object.keys(rankings);
  if (names.length === 1) {
    const only = names[0]!;
    return body(ensureTitles(rankings[only]!, titleHits, limit), [only], degradedFrom);
  }
  const usedModes = ["keyword", "semantic", "graph"].filter((name) => name in rankings);
  return body(ensureTitles(rrfFuse(rankings, limit), titleHits, limit), usedModes, degradedFrom);
}

function body(hits: SearchHit[], usedModes: string[], degradedFrom: string | null): SearchBody {
  return { hits, used_modes: usedModes, degraded_from: degradedFrom };
}
