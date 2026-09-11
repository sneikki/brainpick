/** Semantic retrieval (spec/30): embed the query with the recorded backend,
 * cosine top-k over the chunk store, dedupe to documents (best chunk wins). */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DocRecord } from "../compile/t1";
import { cpHead } from "../compile/t2";
import { pySplitWhitespace } from "../core/pyfmt";
import { makeEmbedder } from "../embed";
import { VectorStore } from "../vectorstore";
import { SNIPPET_WINDOW, type SearchHit } from "./keyword";

const OVERFETCH = 4; // chunks per requested doc — several chunks may share a document
const ENTRY_LOOKAHEAD = 400; // chars: how far into a chunk a column-0 list item may start the snippet

/** T2 artifacts are missing or unreadable — callers degrade to keyword. */
export class SemanticUnavailable extends Error {}

export function loadEmbeddingRecord(bp: string): Record<string, unknown> {
  const path = join(bp, "t2", "embedding.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SemanticUnavailable("t2/embedding.json is missing — run: brainpick compile");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Python round(score, 6) — ties-to-even differences at the 7th decimal are
 * unobservable here (conformance compares result sets, not scores). */
function round6(x: number): number {
  return Number(x.toFixed(6));
}

/** spec/50-shaped hits with source "semantic". Query-time embedding MUST use
 * the t2/embedding.json record — that is how one engine searches vectors the
 * other compiled. */
/** The snippet a semantic hit shows: the chunk's evidence from its first WHOLE line.
 * The chunker cuts by character count, so a later chunk (ord > 0) opens mid-line inside
 * the overlap — that partial line is dropped; leading blank and heading lines are
 * skipped too, since the hit already names the doc. In a log-shaped doc an entry is a
 * column-0 list item with indented continuation lines, so when one starts within the
 * first ENTRY_LOOKAHEAD chars the snippet opens there rather than mid-entry. A chunk
 * that is a single partial line still yields its head rather than nothing. */
export function chunkEvidence(text: string, ord: number): string | null {
  let lines = text.split("\n");
  if (ord > 0 && lines.length > 1) lines = lines.slice(1);
  while (lines.length > 0 && (lines[0]!.trim() === "" || lines[0]!.trimStart().startsWith("#"))) lines.shift();
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (offset > ENTRY_LOOKAHEAD) break;
    const line = lines[i]!;
    if (line.startsWith("* ") || line.startsWith("- ")) {
      lines = lines.slice(i);
      break;
    }
    offset += line.length + 1;
  }
  const body = lines.length > 0 ? lines.join("\n") : text;
  const snippet = pySplitWhitespace(cpHead(body, SNIPPET_WINDOW)).join(" ");
  return snippet !== "" ? snippet : null;
}

export async function semanticSearch(
  bp: string,
  records: readonly DocRecord[],
  query: string,
  limit = 8,
): Promise<SearchHit[]> {
  const record = loadEmbeddingRecord(bp);
  const embedder = makeEmbedder(
    String(record["kind"] ?? ""),
    String(record["endpoint"] ?? ""),
    String(record["model"] ?? ""),
    process.env["OPENAI_API_KEY"] ?? "",
  );
  const [vector] = await embedder.embed([String(record["query_prefix"] ?? "") + query]);
  if (!vector!.some((x) => x !== 0)) {
    return []; // an all-zero query vector has no cosine neighborhood
  }

  const rows = await new VectorStore(join(bp, "t2", "lancedb")).queryVectors(
    vector!,
    Math.max(limit * OVERFETCH, 32),
  );
  const byPath = new Map(records.filter((r) => !r.reserved).map((r) => [r.path, r]));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // nearest first; the first chunk of a doc is its best chunk
    const doc = String(row["doc"]);
    if (seen.has(doc)) continue;
    seen.add(doc);
    const meta = byPath.get(doc);
    if (meta === undefined) continue; // a vector for a doc that no longer exists — stale store, skip
    hits.push({
      description: meta.description,
      path: doc,
      score: round6(1.0 - Number(row["_distance"] ?? 0.0)),
      snippet: chunkEvidence(String(row["text"]), Number(row["ord"] ?? 0)),
      source: "semantic",
      title: meta.title,
    });
    if (hits.length === limit) break;
  }
  return hits;
}
