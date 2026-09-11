/** brainpick recall (spec/72): prompt-time memory for harness hooks
 * (the twin of packages/python/tests/test_recall.py). */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runCompile } from "../src/compile/pipeline";
import { extractTerms, gated, parsePayload, recallMirror, render, sessionFile } from "../src/recall";
import { cleanup, copyBundle, tempDir } from "./helpers";

const savedLogDir = process.env["BRAINPICK_QUERY_LOG_DIR"];
afterEach(() => {
  if (savedLogDir === undefined) delete process.env["BRAINPICK_QUERY_LOG_DIR"];
  else process.env["BRAINPICK_QUERY_LOG_DIR"] = savedLogDir;
  cleanup();
});

const HEADER =
  "memories matching this prompt (each shown once per session; brain_read(path) opens the whole doc):";
const DAY =
  "# 2026-06-02\n\n## 2026-06-02\n\n" +
  "* **11:15** `kuu` · note — the ferry timetable changed for the autumn.\n\n" +
  "* **09:00** `kuu` · note — the tide gauge at the harbour logged a spring flood.\n" +
  "  The water stood a metre above the pier.\n";
const FLOOD = "What did the tide gauge at the harbour log about the spring flood?";

function hit(path: string, title = "T", description = "", snippet: string | null = null) {
  return { path, title, description, snippet };
}

// -- the query -----------------------------------------------------------------------

test("terms match each pattern separately then sort and cap", () => {
  const prompt =
    "Deploy `pipeless core` via deploy-prod: SHAI-127 broke run_compile in brainSearch " +
    "and brain-recall.sh, see AGENTS.md and the ID";
  expect(extractTerms(prompt)).toEqual([
    "AGENTS", "AGENTS.md", "SHAI", "SHAI-127",
    "brain-recall", "brain-recall.sh", "brainSearch", "deploy-prod",
  ]);
});

test("terms use an ascii word boundary", () => {
  expect(extractTerms("xÄBCD and more words here")).toEqual(["BCD"]);
  expect(extractTerms("no identifiers in this plain prompt at all")).toEqual([]);
});

test.each([
  ["/review the whole branch for me now", true],
  ["ok run it", true],
  ["one two three four five", true],
  ["one two three four five six", false],
  ["  spaced   one two three four five six  ", false],
])("the gate: %j", (prompt, closed) => {
  expect(gated(prompt)).toBe(closed);
});

test("parse payload reads three fields", () => {
  const full = { prompt: "a b c d e f", session_id: "s1", hook_event_name: "BeforeAgent", cwd: "/x" };
  expect(parsePayload(full)).toEqual(["a b c d e f", "s1", "BeforeAgent"]);
  expect(parsePayload({ prompt: "a b c d e f" })).toEqual(["a b c d e f", null, "UserPromptSubmit"]);
  expect(parsePayload({ prompt: "a b c d e f", session_id: "" })).toEqual(["a b c d e f", null, "UserPromptSubmit"]);
  for (const bad of [null, [], "text", { prompt: 3 }, {}]) expect(parsePayload(bad)).toBeNull();
});

// -- once per session ----------------------------------------------------------------

test("session file location and sanitizing", () => {
  const base = tempDir();
  expect(sessionFile(null, {})).toBeNull();
  expect(sessionFile("a/../b c", { BRAINPICK_RECALL_STATE_DIR: base })).toBe(join(base, "a____b_c"));
  expect(sessionFile("s-1", { XDG_RUNTIME_DIR: "/run/user/1" })).toBe(join("/run/user/1", "brainpick", "recall", "s-1"));
  expect(sessionFile("s", {})).toBe(join(tmpdir(), "brainpick-recall", "s"));
});

// -- rendering -----------------------------------------------------------------------

test("render quotes entries and pages then points", () => {
  const hits = [
    hit("journals/2026-06-02.md", "2026-06-02", "", "* **09:00** `kuu` · note — the flood.\n  more"),
    hit("maa.md", "Maa", "The blue\nworld.", "# Maa The earth"),
    hit("kuu.md", "Kuu", "", "# Kuu tides"),
    hit("aurinko.md", "Aurinko", "The star.", null),
  ];
  const entries: Record<string, string> = {
    "journals/2026-06-02.md#09:00": "* **09:00** `kuu` · note — the flood.\n  more lines",
  };
  const [context, keys] = render("brain", hits, (path, hhmm) => entries[`${path}#${hhmm}`] ?? "", new Set());
  expect(context).toBe(
    `brain ${HEADER}\n\n` +
      "### journals/2026-06-02.md (09:00)\n* **09:00** `kuu` · note — the flood.\n  more lines\n\n" +
      "### maa.md — Maa\nThe blue world.\n↳ # Maa The earth\n\n" +
      "### aurinko.md — Aurinko\nThe star.\n\n" +
      "Further hits (pointers only):\n- kuu.md — Kuu: # Kuu tides\n",
  );
  expect(keys).toEqual(["journals/2026-06-02.md#09:00", "maa.md", "kuu.md", "aurinko.md"]);
});

test("render caps quoted blocks and skips seen keys", () => {
  const hits = [...Array.from({ length: 7 }, (_, i) => hit(`p${i}.md`, `P${i}`, "desc")), hit("e.md", "E", "", "* **10:00** x")];
  const [context, keys] = render("b", hits, () => "* **10:00** x", new Set(["p0.md"]));
  expect(context!.split("\n").filter((line) => line.startsWith("### "))).toEqual(
    [1, 2, 3, 4, 5].map((i) => `### p${i}.md — P${i}`),
  );
  expect(context!.endsWith("Further hits (pointers only):\n- p6.md — P6\n- e.md — E: * **10:00** x\n")).toBe(true);
  expect(context).not.toContain("p0.md");
  expect(keys).not.toContain("p0.md");
  expect(keys[keys.length - 1]).toBe("e.md#10:00");
});

test("render points at an entry it cannot read and prints nothing without hits", () => {
  const [context] = render("b", [hit("gone.md", "Gone", "", "* **08:00** x")], () => "", new Set());
  expect(context!.endsWith("Further hits (pointers only):\n- gone.md — Gone: * **08:00** x\n")).toBe(true);
  expect(render("b", [], () => "", new Set())).toEqual([null, []]);
  expect(render("b", [hit("a.md")], () => "", new Set(["a.md"]))).toEqual([null, []]);
});

// -- the command ---------------------------------------------------------------------

async function brain(): Promise<{ root: string; env: Record<string, string>; base: string }> {
  const root = copyBundle("kotiaurinko");
  mkdirSync(join(root, "paivakirja"));
  writeFileSync(join(root, "paivakirja", "2026-06-02.md"), DAY, "utf8");
  await runCompile(root);
  const base = tempDir();
  process.env["BRAINPICK_QUERY_LOG_DIR"] = join(base, "queries");
  return { root, env: { BRAINPICK_RECALL_STATE_DIR: join(base, "state") }, base };
}

test("recall quotes the matching journal entry once per session", async () => {
  const { root, env, base } = await brain();
  const payload = JSON.stringify({ prompt: FLOOD, session_id: "s-1" });
  const { out } = await recallMirror(root, payload, 10, env);
  const line = JSON.parse(out!);
  expect(out).toBe(JSON.stringify(line)); // one compact line (console.log adds the newline)
  expect(line.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  const context: string = line.hookSpecificOutput.additionalContext;
  expect(context.startsWith(`kotiaurinko ${HEADER}\n\n`)).toBe(true);
  expect(context).toContain(
    "### paivakirja/2026-06-02.md (09:00)\n" +
      "* **09:00** `kuu` · note — the tide gauge at the harbour logged a spring flood.\n" +
      "  The water stood a metre above the pier.\n\n",
  );
  expect(context).not.toContain("ferry");
  expect(readFileSync(join(base, "state", "s-1"), "utf8").split("\n")[0]).toBe("paivakirja/2026-06-02.md#09:00");
  const logged = JSON.parse(readFileSync(join(base, "queries", "recall-s-1.jsonl"), "utf8").split("\n")[0]!);
  expect(logged.situation).toBe(FLOOD);
  expect(logged.terms).toEqual([]);

  const again = await recallMirror(root, payload, 10, env);
  expect(again.out ?? "").not.toContain("paivakirja/2026-06-02.md (09:00)");
});

test("recall without a session keeps no state and echoes the event", async () => {
  const { root, env, base } = await brain();
  const payload = JSON.stringify({ prompt: FLOOD, hook_event_name: "BeforeAgent" });
  const first = JSON.parse((await recallMirror(root, payload, 10, env)).out!);
  const second = JSON.parse((await recallMirror(root, payload, 10, env)).out!);
  expect(first).toEqual(second);
  expect(first.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  expect(existsSync(join(base, "state"))).toBe(false);
});

test.each([
  "not json",
  "[]",
  JSON.stringify({ prompt: "ok run it" }),
  JSON.stringify({ prompt: "/review this whole branch for me please" }),
])("recall is silent on gated or unreadable input: %s", async (stdin) => {
  const { root, env } = await brain();
  expect((await recallMirror(root, stdin, 10, env)).out).toBeUndefined();
});

test("recall on an uncompiled bundle prints the reason to stderr only", async () => {
  const root = copyBundle("kotiaurinko");
  const result = await recallMirror(root, JSON.stringify({ prompt: "how do the tides of maa follow kuu" }), 10, {});
  expect(result.out).toBeUndefined();
  expect(result.err).toContain("compile");
});
