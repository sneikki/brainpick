/** MCP tool payloads (spec/70): budget shaping, forgiving resolution, guarded
 * writes, base_sha conflicts (the twin of packages/python/tests/test_mcp_tools.py). */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { loadConfig } from "../src/config";
import { sha256Hex } from "../src/core/canonical";
import {
  extractSections,
  neighborsPayload,
  outline,
  overviewPayload,
  readPayload,
  searchPayload,
  showPayload,
  tokensOf,
  writePayload,
} from "../src/mcp";
import { logQuery, newSessionId } from "../src/querylog";
import { ServeState } from "../src/serve/state";
import { cleanup, copyBundle, prependPath, stageFakeHenxels, stageT3Export, tempDir } from "./helpers";

const NEW_DOC =
  "---\ntype: Concept\ntitle: Uusi kivi\ndescription: A new rock.\n---\n\n# Uusi kivi\n\nNear [Kuu](kuu.md).\n";
const KUU_REWRITE =
  "---\ntype: Concept\ntags: [kuu]\ntimestamp: 2026-06-15T08:30:00Z\n---\n\n" +
  "# Kuu\n\nThe moon pulls the tides of [Maa](maa.md), rewritten.\n";

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );
}

const savedPath = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = savedPath;
  cleanup();
});

async function makeState(root: string): Promise<ServeState> {
  const state = new ServeState(root, loadConfig(root));
  await state.load();
  return state;
}

function treeDocCount(result: Record<string, unknown>): number {
  return (result["tree"] as Array<{ docs: unknown[] }>).reduce((n, g) => n + g.docs.length, 0);
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

test("tokensOf is chars over four", () => {
  const payload = { text: "a".repeat(400) };
  // Python len(json.dumps(payload, ensure_ascii=False)) // 4 — note the default
  // ", " / ": " separators: '{"text": "' + 400 a's + '"}' = 412 chars.
  expect(tokensOf(payload)).toBe(103);
});

test("overview counts and tree", async () => {
  const root = copyBundle();
  const result = overviewPayload(await makeState(root));
  const counts = result["counts"] as Record<string, number>;
  expect(counts["docs"]).toBe(10);
  expect(counts["ghosts"]).toBe(1);
  expect(result["bundle"]).toBe("kotiaurinko");
  expect((result["tree"] as Array<{ group: string }>).map((g) => g.group)).toEqual(["concepts", "saaret"]);
  expect(result["truncated"]).toBe(false);
  expect(result["hint"]).toBeTruthy();
});

test("overview top_ghosts is the write-next queue", async () => {
  const root = copyBundle();
  const result = overviewPayload(await makeState(root));
  expect(result["top_ghosts"]).toEqual([{ target: "olematon.md", count: 1 }]);
});

test("overview budget trims tree", async () => {
  const state = await makeState(copyBundle());
  const full = overviewPayload(state);
  const slim = overviewPayload(state, 80);
  expect(slim["truncated"]).toBe(true);
  expect(treeDocCount(slim)).toBeLessThan(treeDocCount(full));
});

test("overview similarity_gaps_open_count is zero when the artifact is absent", async () => {
  const root = copyBundle();
  const result = overviewPayload(await makeState(root));
  expect(result["similarity_gaps_open_count"]).toBe(0);
});

test("overview similarity_gaps_open_count reads the artifact", async () => {
  const root = copyBundle();
  const state = await makeState(root); // compiles first (T2 off — no artifact yet)
  writeFileSync(
    join(root, ".brainpick", "t1", "similarity-gaps.json"),
    JSON.stringify({
      pairs: [
        { a: "a.md", b: "b.md", score: 0.9, status: "open" },
        { a: "c.md", b: "d.md", score: 0.8, status: "dismissed" },
      ],
      threshold: 0.75, max_pairs: 50,
    }),
    "utf8",
  );
  expect(overviewPayload(state)["similarity_gaps_open_count"]).toBe(1);
});

test("search hits carry the matched snippet", async () => {
  // a hit names WHERE in the doc the match is — the retriever's snippet rides along,
  // so a long log-shaped page such as a journal day is not reduced to its title (spec/70)
  const root = copyBundle();
  const state = await makeState(root);
  const result = await searchPayload(state, "tides", "keyword");
  const top = (result["hits"] as Array<Record<string, unknown>>)[0]!;
  expect(top["path"]).toBe("kuu.md");
  expect(typeof top["snippet"]).toBe("string");
  expect(String(top["snippet"]).toLowerCase()).toContain("tides");
  expect(String(top["snippet"]).length).toBeLessThanOrEqual(260);
});

test("search hits have why not bodies", async () => {
  const result = await searchPayload(await makeState(copyBundle()), "aurinko");
  const hits = result["hits"] as Array<Record<string, unknown>>;
  expect(new Set(hits.map((h) => h["path"]))).toEqual(
    new Set(["aurinko.md", "komeetta.md", "planeetat.md", "yksinainen.md"]),
  );
  expect(new Set(Object.keys(hits[0]!))).toEqual(new Set(["path", "title", "description", "score", "why", "snippet"]));
  expect(result["used_modes"]).toEqual(["keyword"]);
  expect(result["degraded_from"]).toBe("semantic"); // auto without T2 says so (spec/30)
  expect(result["truncated"]).toBe(false);
});

test("search budget trims hits", async () => {
  const state = await makeState(copyBundle());
  const full = await searchPayload(state, "aurinko");
  const slim = await searchPayload(state, "aurinko", "auto", 8, 40);
  expect(slim["truncated"]).toBe(true);
  const slimHits = (slim["hits"] as unknown[]).length;
  expect(slimHits).toBeGreaterThanOrEqual(1);
  expect(slimHits).toBeLessThan((full["hits"] as unknown[]).length);
  expect(slim["hint"]).toContain("budget");
});

test("search forgiving modes", async () => {
  const state = await makeState(copyBundle());
  const unknown = await searchPayload(state, "aurinko", "banana");
  expect(unknown["used_modes"]).toEqual(["keyword"]);
  expect(unknown["degraded_from"]).toBe("semantic"); // banana → auto → degraded without T2
  expect(unknown["hint"]).toContain("fell back to auto");
  const keyword = await searchPayload(state, "aurinko", "keyword");
  expect(keyword["degraded_from"]).toBeNull();
  const degraded = await searchPayload(state, "aurinko", "semantic");
  expect(degraded["used_modes"]).toEqual(["keyword"]);
  expect(degraded["degraded_from"]).toBe("semantic");
});

test("search semantic hits via mock vectors", async () => {
  const root = copyBundle();
  writeFileSync(join(root, "brainpick.toml"), '[models.embedding]\nkind = "mock"\n', "utf8");
  const state = await makeState(root);
  expect((state.manifest["tiers"] as Record<string, string>)["t2"]).toBe("fresh");
  const semantic = await searchPayload(state, "kuu vuorovesi maa", "semantic");
  expect(semantic["used_modes"]).toEqual(["semantic"]);
  expect(semantic["degraded_from"]).toBeNull();
  const hits = semantic["hits"] as Array<Record<string, unknown>>;
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) {
    expect(new Set(Object.keys(h))).toEqual(new Set(["path", "title", "description", "score", "why", "snippet"]));
  }
  const fused = await searchPayload(state, "aurinko", "auto");
  expect(fused["used_modes"]).toEqual(["keyword", "semantic"]);
  expect(fused["degraded_from"]).toBeNull();
});

test("read resolution ladder", async () => {
  const state = await makeState(copyBundle());
  expect(readPayload(state, "kuu.md")["path"]).toBe("kuu.md");
  expect(readPayload(state, "kuu")["path"]).toBe("kuu.md"); // stem
  expect(readPayload(state, "komeeta")["path"]).toBe("komeetta.md"); // fuzzy title
  const missing = readPayload(state, "olematon-zzz");
  expect(missing["error"]).toBeTruthy();
  expect((missing["suggestions"] as unknown[]).length).toBeGreaterThan(0);
});

test("read disambiguation", async () => {
  const root = copyBundle();
  for (const [rel, title] of [
    ["koru/helmi.md", "Helmi koru"],
    ["meri/helmi.md", "Helmi meri"],
  ] as const) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(
      join(root, rel),
      `---\ntype: Concept\ntitle: ${title}\ndescription: A pearl.\n---\n\n# ${title}\n\nSee [Kuu](/kuu.md).\n`,
      "utf8",
    );
  }
  const state = await makeState(root);
  const result = readPayload(state, "helmi");
  expect(new Set((result["disambiguation"] as Array<{ path: string }>).map((c) => c.path))).toEqual(
    new Set(["koru/helmi.md", "meri/helmi.md"]),
  );
  expect(result["hint"]).toBeTruthy();
});

test("read full doc shape", async () => {
  const result = readPayload(await makeState(copyBundle()), "planeetat.md");
  expect(result["truncated"]).toBe(false);
  expect(result["content"]).toContain("Every world orbits");
  expect(result["outline"]).toEqual(["# Planeetat"]);
  const frontmatter = result["frontmatter"] as Record<string, unknown>;
  expect(frontmatter["type"]).toBe("Concept");
  expect(frontmatter["timestamp"]).toBe("2026-06-01T00:00:00Z");
  const neighbors = result["neighbors"] as { in: Array<{ path: string }>; out: Array<{ path: string }> };
  expect(new Set(neighbors.out.map((n) => n.path))).toEqual(new Set(["aurinko.md", "maa.md"]));
  expect(new Set(neighbors.in.map((n) => n.path))).toEqual(new Set(["aurinko.md", "index.md", "maa.md"]));
});

test("read sections and budget", async () => {
  const root = copyBundle();
  writeFileSync(
    join(root, "osiot.md"),
    "---\ntype: Concept\ntitle: Osiot\ndescription: A sectioned doc.\n---\n\n" +
      "# Osiot\n\nIntro, see [Kuu](kuu.md).\n\n" +
      "## Alpha\n\n" +
      "Alpha text. ".repeat(120) +
      "\n\n## Beta\n\nBeta text.\n",
    "utf8",
  );
  const state = await makeState(root);
  const full = readPayload(state, "osiot.md");
  expect(full["outline"]).toEqual(["# Osiot", "## Alpha", "## Beta"]);
  const onlyBeta = readPayload(state, "osiot.md", ["Beta"]);
  expect(onlyBeta["content"]).toContain("Beta text.");
  expect(onlyBeta["content"]).not.toContain("Alpha text.");
  const slim = readPayload(state, "osiot.md", null, 60);
  expect(slim["truncated"]).toBe(true);
  expect((slim["content"] as string).length).toBeLessThan((full["content"] as string).length);
  expect(slim["hint"]).toContain("sections");
});

test("neighbors depth and degrade", async () => {
  const root = copyBundle();
  // graph = "off": no T3 export exists, so layer=entities degrades to links —
  // the algorithmic default would otherwise serve a real (derived) entity layer.
  writeFileSync(join(root, "brainpick.toml"), '[modules]\ngraph = "off"\n', "utf8");
  const state = await makeState(root);
  const one = neighborsPayload(state, "maa.md");
  expect(one["center"]).toBe("maa.md");
  const onePaths = new Set((one["nodes"] as Array<{ path: string }>).map((n) => n.path));
  expect(onePaths).toEqual(new Set(["maa.md", "kuu.md", "planeetat.md", "index.md"]));
  const center = (one["nodes"] as Array<{ path: string; distance: number }>).find((n) => n.path === "maa.md")!;
  expect(center.distance).toBe(0);
  const two = neighborsPayload(state, "maa.md", 2);
  const twoPaths = new Set((two["nodes"] as Array<{ path: string }>).map((n) => n.path));
  expect(twoPaths.has("aurinko.md")).toBe(true);
  expect(twoPaths.has("saaret/atolli.md")).toBe(true);
  const clamped = neighborsPayload(state, "maa.md", 9); // forgiving: clamps to 3
  const depth3 = neighborsPayload(state, "maa.md", 3);
  expect(new Set((clamped["nodes"] as Array<{ path: string }>).map((n) => n.path))).toEqual(
    new Set((depth3["nodes"] as Array<{ path: string }>).map((n) => n.path)),
  );
  const degraded = neighborsPayload(state, "maa.md", 1, "entities");
  expect(degraded["degraded_from"]).toBe("entities");
  const edges = degraded["edges"] as Array<Record<string, unknown>>;
  expect(edges.length).toBeGreaterThan(0);
  for (const e of edges) {
    expect(new Set(Object.keys(e))).toEqual(new Set(["source", "target", "kind"]));
  }
});

async function stateWithT3(root: string): Promise<ServeState> {
  const state = await makeState(root);
  stageT3Export(root);
  state.reloadArtifacts();
  return state;
}

test("neighbors entities layer over staged export", async () => {
  const state = await stateWithT3(copyBundle());
  const result = neighborsPayload(state, "kuu", 1, "entities"); // forgiving stem resolution
  expect(result["center"]).toBe("kuu.md");
  expect(result["degraded_from"]).toBeNull();
  const nodes = result["nodes"] as Array<{ id: string; distance: number; source_docs: string[] }>;
  expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(["kuu", "maa", "vuorovesi", "planeetat"]));
  const kuu = nodes.find((n) => n.id === "kuu")!;
  expect(new Set(Object.keys(kuu))).toEqual(new Set(["id", "name", "description", "distance", "source_docs"]));
  expect(kuu.distance).toBe(0);
  const grounding = new Set<string>(nodes.flatMap((n) => n.source_docs));
  expect(grounding).toEqual(new Set(["aurinko.md", "kuu.md", "maa.md", "planeetat.md"]));
  expect(result["edges"]).toContainEqual({ src: "kuu", dst: "vuorovesi" });
});

test("neighbors both layer overlays tagged", async () => {
  const state = await stateWithT3(copyBundle());
  const result = neighborsPayload(state, "kuu.md", 1, "both");
  expect(result["degraded_from"]).toBeNull();
  const nodes = result["nodes"] as Array<Record<string, unknown>>;
  expect(new Set(nodes.map((n) => n["layer"]))).toEqual(new Set(["links", "entities"]));
  expect(nodes.some((n) => n["layer"] === "links" && "path" in n)).toBe(true);
  expect(nodes.some((n) => n["layer"] === "entities" && "id" in n)).toBe(true);
});

test("search graph mode over staged export", async () => {
  const state = await stateWithT3(copyBundle());
  const result = await searchPayload(state, "what orbits the star", "graph", 4);
  const hits = result["hits"] as Array<{ path: string; why: string }>;
  expect(new Set(hits.map((h) => h.path))).toEqual(
    new Set(["aurinko.md", "komeetta.md", "maa.md", "planeetat.md"]),
  );
  expect(result["used_modes"]).toEqual(["graph"]);
  expect(result["degraded_from"]).toBeNull();
  expect(hits.every((h) => h.why.includes("entity graph"))).toBe(true);
});

test("write rejects traversal", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const result = await writePayload(state, "../ulos.md", "# Ulos\n");
  expect(result["ok"]).toBe(false);
  expect(result["instruction"]).toContain("bundle");
  expect(exists(join(root, "..", "ulos.md"))).toBe(false);
});

test("write rejects non-kebab", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const result = await writePayload(state, "Kuun Vaiheet.md", "# Kuun vaiheet\n");
  expect(result["ok"]).toBe(false);
  expect(result["instruction"]).toContain("kuun-vaiheet.md");
  expect(exists(join(root, "Kuun Vaiheet.md"))).toBe(false);
});

test("write refuses clobber on create", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const result = await writePayload(state, "kuu.md", "# Kaappaus\n");
  expect(result["ok"]).toBe(false);
  expect(result["instruction"]).toContain("replace");
  expect(readFileSync(join(root, "kuu.md"), "utf8")).toContain("tides");
});

test("write happy path bumps seq and timestamp", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const queue = state.subscribe();
  const result = await writePayload(state, "uusi-kivi", NEW_DOC);
  expect(result["ok"]).toBe(true);
  expect(result["path"]).toBe("uusi-kivi.md");
  expect(result["seq"]).toBe(2);
  expect(state.seq).toBe(2);
  const text = readFileSync(join(root, "uusi-kivi.md"), "utf8");
  expect(text).toMatch(/^timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  expect(queue.drain().map(([name]) => name)).toContain("graph.delta"); // went out the shared path
  expect(readFileSync(join(root, "index.md"), "utf8")).toContain("- [Uusi kivi](uusi-kivi.md)");
});

test("write leaves frontmatter-free docs without a timestamp block", async () => {
  // journals and OKF reserved files carry no frontmatter by contract; a write that
  // passed henxels must not grow one on the way out (spec/70 step 4)
  const root = copyBundle();
  const state = await makeState(root);
  const journal = "# 2026-06-01\n\n## 2026-06-01\n\n* **08:00** `kuu` · note — tides logged.\n";
  const result = await writePayload(state, "paivakirja/2026-06-01", journal);
  expect(result["ok"]).toBe(true);
  expect(readFileSync(join(root, "paivakirja", "2026-06-01.md"), "utf8")).toBe(journal);
});

test("write append_section", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const result = await writePayload(state, "kuu.md", "## Nousuvesi\n\nSpring tides.\n", "append_section");
  expect(result["ok"]).toBe(true);
  const text = readFileSync(join(root, "kuu.md"), "utf8");
  expect(text).toContain("## Nousuvesi");
  expect(text).toContain("The moon pulls"); // the original body survives
});

test("write add_entry slots into the newest-first day", async () => {
  // mode add_entry (spec/70): one entry in, the server places it by time — a missing day
  // is created with its head, a later entry goes first, an earlier one after, and the
  // caller never echoes the day back.
  const root = copyBundle();
  const state = await makeState(root);
  const day = join(root, "paivakirja", "2026-06-02.md");
  const first = "* **09:00** `kuu` · note — first.\n  more.\n";
  expect((await writePayload(state, "paivakirja/2026-06-02", first, "add_entry"))["ok"]).toBe(true);
  expect(readFileSync(day, "utf8")).toBe("# 2026-06-02\n\n## 2026-06-02\n\n" + first);
  expect((await writePayload(state, "paivakirja/2026-06-02", "* **07:30** `kuu` · note — earlier.", "add_entry"))["ok"]).toBe(true);
  expect((await writePayload(state, "paivakirja/2026-06-02", "* **11:15** `kuu` · note — later.", "add_entry"))["ok"]).toBe(true);
  expect(readFileSync(day, "utf8")).toBe(
    "# 2026-06-02\n\n## 2026-06-02\n\n" +
      "* **11:15** `kuu` · note — later.\n\n" +
      "* **09:00** `kuu` · note — first.\n  more.\n\n" +
      "* **07:30** `kuu` · note — earlier.\n",
  );
  const bad = await writePayload(state, "paivakirja/2026-06-02", "## Not an entry\n", "add_entry");
  expect(bad["ok"]).toBe(false);
  expect(String(bad["instruction"])).toContain("HH:MM");
  const page = await writePayload(state, "muistio", "* **10:00** `kuu` · note — x", "add_entry");
  expect(page["ok"]).toBe(false);
  expect(String(page["instruction"])).toContain("YYYY-MM-DD");
  expect(existsSync(join(root, "muistio.md"))).toBe(false);
});

test("concurrent add_entry loses nothing", async () => {
  // Fifty overlapping add_entry calls to one day (spec/70: writes are serialized server-side)
  // — every entry lands, in time order, none overwritten.
  const root = copyBundle();
  const state = await makeState(root);
  const pad = (n: number) => String(n).padStart(2, "0");
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      writePayload(state, "paivakirja/2026-06-03", `* **${pad(Math.floor(i / 60))}:${pad(i % 60)}** \`kuu\` · note — entry ${i}.`, "add_entry"),
    ),
  );
  expect(results.every((r) => r["ok"] === true)).toBe(true);
  const text = readFileSync(join(root, "paivakirja", "2026-06-03.md"), "utf8");
  const times = text.split("\n").filter((l) => l.startsWith("* **")).map((l) => l.slice(4, 9));
  expect(times.length).toBe(50);
  expect(times).toEqual([...times].sort().reverse());
});

test("write gate refusal", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const result = await writePayload(state, "uusi.md", "# X\n", "create", {
    refusal: 'writes are off — set [serve] writes = "guarded"',
  });
  expect(result["ok"]).toBe(false);
  expect(result["instruction"]).toContain("guarded");
  expect(exists(join(root, "uusi.md"))).toBe(false);
});

test("write henxels violation restores", async () => {
  const root = copyBundle();
  writeFileSync(join(root, "henxels.yaml"), "henxels: []\n", "utf8");
  const bin = stageFakeHenxels(join(tempDir(), "bin"), "kebab-case or bust");
  process.env["PATH"] = prependPath(savedPath, bin);
  const state = await makeState(root);

  const created = await writePayload(state, "uusi.md", "# X\n");
  expect(created["ok"]).toBe(false);
  expect((created["instruction"] as string).trim()).toBe("kebab-case or bust");
  expect(exists(join(root, "uusi.md"))).toBe(false); // created file rolled back

  const replaced = await writePayload(state, "kuu.md", "# Kuu\n\nClobbered.\n", "replace");
  expect(replaced["ok"]).toBe(false);
  expect(readFileSync(join(root, "kuu.md"), "utf8")).toContain("tides"); // bytes restored
  expect(state.seq).toBe(1);
});

test("write honours a contract above the bundle", async () => {
  // spec/80 layout: henxels.yaml at the repo root, the bundle below it. `auto` must
  // still run the contract — henxels resolves it by walking up, and so must we
  const root = copyBundle();
  writeFileSync(join(dirname(root), "henxels.yaml"), "henxels: []\n", "utf8");
  const bin = stageFakeHenxels(join(tempDir(), "bin"), "kebab-case or bust");
  process.env["PATH"] = prependPath(savedPath, bin);
  const state = await makeState(root);
  expect(state.config.validate.henxels).toBe("auto");

  const created = await writePayload(state, "uusi.md", "# X\n");
  expect(created["ok"]).toBe(false);
  expect((created["instruction"] as string).trim()).toBe("kebab-case or bust");
  expect(exists(join(root, "uusi.md"))).toBe(false);
});

test("write henxels missing warns", async () => {
  const root = copyBundle();
  writeFileSync(join(root, "henxels.yaml"), "henxels: []\n", "utf8");
  const empty = join(tempDir(), "emptybin");
  mkdirSync(empty, { recursive: true });
  process.env["PATH"] = empty;
  const state = await makeState(root);
  const result = await writePayload(state, "uusi-kivi.md", NEW_DOC);
  expect(result["ok"]).toBe(true);
  expect(result["warning"]).toBeTruthy();
  expect(statSync(join(root, "uusi-kivi.md")).isFile()).toBe(true);
});

// -- base_sha (spec/70 optimistic concurrency, detection half) ----------------------

test("write with stale base_sha conflicts without writing", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const before = readFileSync(join(root, "kuu.md"));
  const result = await writePayload(state, "kuu.md", "# Kuu\n\nRewritten.\n", "replace", {
    baseSha: "0".repeat(64),
  });
  expect(result["ok"]).toBe(false);
  expect(result["conflict"]).toBe(true);
  expect(result["current_sha"]).toBe(sha256Hex(before));
  expect(result["theirs"]).toContain("tides");
  expect(result["instruction"]).toContain("re-read");
  expect(result["merged"]).toBeUndefined(); // no git base, no model → the manual path
  expect(readFileSync(join(root, "kuu.md"))).toEqual(before); // nothing written
  expect(state.seq).toBe(1);
});

test("write with matching base_sha proceeds", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const currentSha = sha256Hex(readFileSync(join(root, "kuu.md")));
  const result = await writePayload(state, "kuu.md", "# Kuu\n\nRewritten, honestly.\n", "replace", {
    baseSha: currentSha,
  });
  expect(result["ok"]).toBe(true);
  expect(result["seq"]).toBe(2);
  expect(readFileSync(join(root, "kuu.md"), "utf8")).toContain("Rewritten, honestly.");
});

test("write with base_sha against a vanished doc conflicts", async () => {
  const root = copyBundle();
  const state = await makeState(root);
  const result = await writePayload(state, "poistettu.md", "# Uusi\n", "replace", {
    baseSha: "a".repeat(64),
  });
  expect(result["ok"]).toBe(false);
  expect(result["conflict"]).toBe(true);
  expect(result["current_sha"]).toBeNull();
  expect(result["theirs"]).toBeNull();
  expect(exists(join(root, "poistettu.md"))).toBe(false);
});

test("conflict theirs is budget-shaped", async () => {
  const root = copyBundle();
  writeFileSync(
    join(root, "pitka.md"),
    "---\ntype: Concept\ntitle: Pitka\ndescription: Long.\n---\n\n# Pitka\n\n" + "sana ".repeat(3000),
    "utf8",
  );
  const state = await makeState(root);
  const result = await writePayload(state, "pitka.md", "# Pitka\n", "replace", {
    baseSha: "0".repeat(64),
    budgetTokens: 200,
  });
  expect(result["conflict"]).toBe(true);
  expect(result["truncated"]).toBe(true);
  const theirs = result["theirs"] as string;
  expect(theirs.endsWith(" …")).toBe(true);
  expect(theirs.length).toBeLessThan(3000 * 5);
  expect(result["current_sha"]).toBe(sha256Hex(readFileSync(join(root, "pitka.md")))); // retry key never trimmed
});

// -- the merge ladder on a stale write (spec/70): three-way | llm | manual ------------

test("conflict merged proposal from the configured model", async () => {
  const root = copyBundle();
  writeFileSync(join(root, "brainpick.local.toml"), '[models.extraction]\nkind = "mock"\n', "utf8");
  const state = await makeState(root);
  const result = await writePayload(state, "kuu.md", KUU_REWRITE, "replace", { baseSha: "0".repeat(64) });
  expect(result["conflict"]).toBe(true);
  const merged = result["merged"] as { strategy: string; content: string };
  expect(merged.strategy).toBe("llm"); // no git base → the two-input model merge
  expect(merged.content).toBe(KUU_REWRITE); // MockChat echoes the YOURS section
  expect(result["hint"]).toContain("proposal");
  expect(readFileSync(join(root, "kuu.md"), "utf8")).not.toContain("rewritten"); // never applied
});

test("conflict three-way from a git base", async () => {
  const root = copyBundle();
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const baseBytes = readFileSync(join(root, "kuu.md"));
  const baseText = baseBytes.toString("utf8");

  // A foreign writer edits the tides line after our writer read the doc.
  const theirs = baseText.replaceAll(
    "The moon pulls the tides of [Maa](maa.md).",
    "The moon pulls the spring tides of [Maa](maa.md).",
  );
  writeFileSync(join(root, "kuu.md"), theirs, "utf8");

  const state = await makeState(root);
  const yours = baseText + "\n## Vaiheet\n\nNew moon, then full moon.\n";
  const result = await writePayload(state, "kuu.md", yours, "replace", { baseSha: sha256Hex(baseBytes) });
  expect(result["conflict"]).toBe(true);
  const merged = result["merged"] as { strategy: string; content: string };
  expect(merged.strategy).toBe("three-way"); // git HEAD supplied the verified base
  expect(merged.content).toContain("spring tides"); // their edit survives
  expect(merged.content).toContain("## Vaiheet"); // your edit survives
  expect(readFileSync(join(root, "kuu.md"), "utf8")).not.toContain("## Vaiheet"); // proposal only
});

// -- brain_show (spec/95): the 6th tool — ephemeral presentations, not write-gated --

test("showPayload reports shown, dropped, seq, and a hint", async () => {
  const state = await makeState(copyBundle());
  const queue = state.subscribe();
  const result = showPayload(state, ["aurinko.md", "ei-ole"], null, null, "hi");
  expect(result["ok"]).toBe(true);
  expect(result["shown"]).toBe(1);
  expect(result["dropped"]).toEqual(["ei-ole"]);
  expect(result["seq"]).toBe(1);
  // the exact hint — pinned so it stays byte-identical to the Python twin (parity)
  expect(result["hint"]).toBe(
    "showing 1 node(s) live in every open UI — " +
      "call brain_show again to change it, or with clear:true to dismiss. (dropped 1: ei-ole)",
  );
  expect(queue.drain().map((e) => e[0])).toEqual(["brain.show"]); // the open UIs light up
  expect(state.seq).toBe(1); // never writes / compiles
});

test("showPayload clear has a dedicated hint", async () => {
  const state = await makeState(copyBundle());
  const result = showPayload(state, null, null, null, null, true);
  expect(result).toEqual({
    ok: true,
    shown: 0,
    dropped: [],
    seq: 1,
    hint: "cleared — every open UI dropped its spotlight and caption.",
  });
});


// -- journal entries as read units (spec/70) ------------------------------------------

const DAY =
  "# 2026-09-09\n\n## 2026-09-09\n\n" +
  "* **05:50** `pipeless` · debug — proof audits passed on version/229\n  audit details\n\n" +
  "* **05:30** `nuutti-brain` · feature — every harness wired\n  wiring details\n  more wiring\n\n" +
  "* **05:05** `pipeless` · debug — listing fallback stops early\n  listing details\n";

test("outline lists journal entries and sections take a time", () => {
  const lines = outline(DAY);
  expect(lines.slice(0, 2)).toEqual(["# 2026-09-09", "## 2026-09-09"]);
  expect(lines[2]!.startsWith("* **05:50**") && lines.length === 5).toBe(true);
  const one = extractSections(DAY, ["05:30"]);
  expect(one).toBe("* **05:30** `nuutti-brain` · feature — every harness wired\n  wiring details\n  more wiring\n");
  const two = extractSections(DAY, ["05:50", "05:05"]);
  expect(two.split("* **").length - 1).toBe(2);
  expect(two.includes("05:30")).toBe(false);
  expect(extractSections(DAY, ["## 2026-09-09"]).split("* **").length - 1).toBe(3); // a heading still takes its whole section
});

test("query log writes one raw line per search", () => {
  const dir = tempDir();
  const saved = { log: process.env["BRAINPICK_QUERY_LOG"], dir: process.env["BRAINPICK_QUERY_LOG_DIR"] };
  process.env["BRAINPICK_QUERY_LOG_DIR"] = dir;
  delete process.env["BRAINPICK_QUERY_LOG"];
  try {
    const sid = newSessionId();
    const request = {
      situation: "the deploy failed on a sidecar race",
      terms: ["FUSE"],
      mode: "auto",
      limit: 10,
      scope: null,
    };
    const result = {
      hits: [{ path: "journals/2026-09-09.md" }],
      used_modes: ["keyword", "semantic"],
      degraded_from: null,
    };
    const path = logQuery(sid, "nuutti-brain", request, result);
    logQuery(sid, "nuutti-brain", request, result);
    expect(path).toBe(join(dir, `${sid}.jsonl`));
    const lines = readFileSync(path!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].situation).toBe(request.situation);
    expect(lines[0].terms).toEqual(["FUSE"]);
    expect(lines[0].hits).toEqual(["journals/2026-09-09.md"]);
    expect(lines[0].used_modes).toEqual(["keyword", "semantic"]);
    process.env["BRAINPICK_QUERY_LOG"] = "0";
    expect(logQuery(sid, "nuutti-brain", request, result)).toBeNull();
  } finally {
    if (saved.log === undefined) delete process.env["BRAINPICK_QUERY_LOG"];
    else process.env["BRAINPICK_QUERY_LOG"] = saved.log;
    if (saved.dir === undefined) delete process.env["BRAINPICK_QUERY_LOG_DIR"];
    else process.env["BRAINPICK_QUERY_LOG_DIR"] = saved.dir;
  }
});
