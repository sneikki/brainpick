import { afterEach, expect, test } from "vitest";

import { scan } from "../src/core/bundle";
import { buildDocsRecords } from "../src/compile/t1";
import { queryTokens, search, STOPWORDS, tokenize } from "../src/query/keyword";
import { cleanup, copyBundle } from "./helpers";

afterEach(cleanup);

test("tokenizer parity vector with Python's [^\\W_]+", () => {
  // Shared unit vector: underscore is a boundary, hyphen splits, digits kept — and a run
  // joined by single '-'/'_' is ALSO emitted whole, after its parts (an identifier is a token)
  expect(tokenize("Aurinko-itse_kuu 123 tähti")).toEqual(["aurinko", "itse", "kuu", "123", "tähti", "aurinko-itse_kuu"]);
  expect(tokenize("SAI-PIPELESS-V and identity_authorized_bc_id")).toEqual([
    "sai", "pipeless", "v", "and", "identity", "authorized", "bc", "id", "sai-pipeless-v", "identity_authorized_bc_id",
  ]);
  expect(tokenize("__init__")).toEqual(["init"]); // doubled separators are boundaries, not joins
  expect(tokenize("...")).toEqual([]);
});

test("keyword search set", () => {
  const records = buildDocsRecords(scan(copyBundle()));
  const hits = search(records, "aurinko", 8);
  expect(new Set(hits.map((h) => h.path))).toEqual(
    new Set(["aurinko.md", "komeetta.md", "planeetat.md", "yksinainen.md"]),
  );
  // the doc titled Aurinko outranks passing mentions
  expect(hits[0]!.path).toBe("aurinko.md");
  // reserved docs never surface (index.md links everything)
  expect(hits.every((h) => !h.path.endsWith("index.md"))).toBe(true);
});

test("search result shape", () => {
  const records = buildDocsRecords(scan(copyBundle()));
  const kuuHits = search(records, "tides", 3).filter((h) => h.path === "kuu.md");
  expect(kuuHits).toHaveLength(1);
  const hit = kuuHits[0]!;
  expect(Object.keys(hit).sort()).toEqual(["description", "path", "score", "snippet", "source", "title"]);
  expect(hit.source).toBe("keyword");
  expect(hit.snippet).toContain("tides");
});

test("no hits", () => {
  const records = buildDocsRecords(scan(copyBundle()));
  expect(search(records, "zzzzz kuulumaton", 5)).toEqual([]);
});

test("numeric fragments of a compound are not query terms", () => {
  // A date-prefixed file name in the query must not match every day of that month on its
  // date parts (spec/50): the compound still matches whole, a bare number still matches.
  expect(queryTokens("2026-09-09-soniox-spec.md")).toEqual(["soniox", "spec", "md", "2026-09-09-soniox-spec"]);
  expect(queryTokens("SHAI-127 and error 40002")).toEqual(["shai", "error", "40002", "shai-127"]);
  const records = [
    { path: "j/2026-09-09.md", title: "2026-09-09", description: null, text: "* soniox spec written", reserved: false },
    { path: "j/2026-09-02.md", title: "2026-09-02", description: null, text: "* deepgram dropped", reserved: false },
  ] as unknown as Parameters<typeof search>[0];
  expect(search(records, "2026-09-09-soniox-spec.md").map((h) => h.path)).toEqual(["j/2026-09-09.md"]);
  expect(search(records, "40002")).toEqual([]);
});

test("stopwords drop from the query only", () => {
  // A sentence query no longer matches every doc on its function words (spec/50), and a
  // query made only of stopwords finds nothing — the docs themselves are indexed whole.
  expect(queryTokens("the deploy failed and the tool refused")).toEqual(["deploy", "failed", "tool", "refused"]);
  expect(STOPWORDS.has("the") && !STOPWORDS.has("deploy")).toBe(true);
  const records = [
    { path: "a.md", title: "A", description: null, text: "the moon and the sun", reserved: false },
    { path: "b.md", title: "B", description: null, text: "deploy failed", reserved: false },
  ] as unknown as Parameters<typeof search>[0];
  expect(search(records, "the and")).toEqual([]);
  expect(search(records, "why the deploy failed").map((h) => h.path)).toEqual(["b.md"]);
});

test("keyword snippet opens at the entry head", () => {
  // A log-shaped doc shows the matched entry from its `* ` head, not a window around the
  // word — so a journal hit names the entry (spec/50).
  const text =
    "# 2026-09-09\n\n## 2026-09-09\n\n" +
    "* **05:50** `pipeless` · debug — proof audits passed\n  details about audits\n\n" +
    "* **03:40** `pipeless` · progress — deploy failed on a FUSE mount race\n  more lines\n";
  const records = [{ path: "d.md", title: "2026-09-09", description: null, text, reserved: false }] as unknown as Parameters<
    typeof search
  >[0];
  const hit = search(records, "FUSE mount")[0]!;
  expect(hit.snippet!.startsWith("* **03:40**")).toBe(true);
});

test("keyword snippet picks the entry that matches best", () => {
  const text =
    "# 2026-09-09\n\n## 2026-09-09\n\n" +
    "* **07:45** `brainpick` · decision — example call quoting \"FUSE mount failed\"\n  unrelated\n\n" +
    "* **03:40** `pipeless` · progress — deploy failed on a sidecar FUSE mount race at startup\n  rerun made no revision\n";
  const records = [{ path: "d.md", title: "2026-09-09", description: null, text, reserved: false }] as never;
  const hit = search(records, "FUSE mount race sidecar")[0]!;
  expect(hit.snippet!.startsWith("* **03:40**")).toBe(true);
});

test("journal entries are ranked as units", () => {
  const filler = Array.from({ length: 39 }, (_, i) => {
    const h = String(i + 1).padStart(2, "0");
    return `* **${h}:00** \`x\` · note — unrelated chatter about other things\n  more chatter`;
  }).join("\n");
  const day = filler + "\n* **23:30** `pipeless` · debug — FUSE mount race on the sidecar at startup\n  details\n";
  const records = [
    { path: "journals/day.md", title: "2026-09-09", description: null, text: day, reserved: false },
    { path: "knowledge/page.md", title: "Page", description: null, text: "a page that mentions the sidecar once in passing", reserved: false },
  ] as never;
  const hits = search(records, "FUSE mount race sidecar");
  expect(hits.map((h) => h.path)).toEqual(["journals/day.md", "knowledge/page.md"]);
  expect(hits[0]!.snippet!.startsWith("* **23:30**")).toBe(true);
});
