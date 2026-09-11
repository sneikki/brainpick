/** `brainpick init --template brain` (spec/85): the brain template lives in brainpick
 * (the twin of packages/python/tests/test_brain_template.py). */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";

import { afterEach, expect, test } from "vitest";

import { contractFragment, scaffoldBrain, templateFiles, templateRoot } from "../src/brain-template";
import type { ProbeResult } from "../src/detect";
import { runInit } from "../src/scaffold";
import { cleanup, REPO_ROOT, tempDir } from "./helpers";

afterEach(cleanup);

const CANONICAL = join(REPO_ROOT, "integrations", "brain-template");
const NO_BACKENDS: ProbeResult[] = [["ollama", null], ["lm studio", null], ["llama.cpp", null]];
const GITIGNORE = "_temp/\nbrainpick.local.toml\n.brainpick/\n_todo.md\n";

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function capture(): { print: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { print: (line) => lines.push(line), text: () => lines.join("\n") };
}

// -- one canonical tree, byte-identical shipped copy --------------------------------

test("the shipped template is the canonical tree", () => {
  expect(templateFiles()).toEqual(filesUnder(CANONICAL));
  for (const rel of filesUnder(CANONICAL)) {
    expect(readFileSync(join(templateRoot(), rel)).equals(readFileSync(join(CANONICAL, rel))), rel).toBe(true);
  }
});

test("the first skill never asks for a time", () => {
  const skill = readFileSync(join(CANONICAL, "_brain", "skills", "using-the-brain.md"), "utf8");
  expect(skill).toContain("Never write a time");
  expect(skill).toContain("`add_entry`");
  expect(skill).toContain("`meta`");
  expect(skill).not.toContain("Bump `timestamp`");
  expect(skill).not.toContain("YYYY-MM.md");
});

// -- the scaffold --------------------------------------------------------------------

test("scaffold writes the brain and never overwrites", () => {
  const root = tempDir();
  const report = scaffoldBrain(root, "2026-01-02", "fixturebrain000000000");
  expect(report.written).toEqual(templateFiles());
  expect(report.existing).toEqual([]);
  expect(report.fragment).toBeNull();
  expect(report.gitignore).toBe("created");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(GITIGNORE);
  for (const rel of templateFiles()) expect(readFileSync(join(root, rel), "utf8"), rel).not.toContain("{{");
  expect(readFileSync(join(root, "brainpick.toml"), "utf8")).toContain('id = "fixturebrain000000000"');
  expect(readFileSync(join(root, "_brain", "skills", "using-the-brain.md"), "utf8")).toContain("timestamp: 2026-01-02T00:00:00Z");
  expect(readFileSync(join(root, "_brain", "log.md"), "utf8")).toContain("## 2026-01-02");

  const before = templateFiles().map((rel) => readFileSync(join(root, rel), "utf8"));
  const again = scaffoldBrain(root, "2030-12-31", "otherbrain00000000000");
  expect(again.written).toEqual([]);
  expect(again.existing).toEqual(templateFiles());
  expect(again.gitignore).toBeNull();
  expect(templateFiles().map((rel) => readFileSync(join(root, rel), "utf8"))).toEqual(before);
});

test("an existing contract gets the fragment and gitignore is appended", () => {
  const root = tempDir();
  writeFileSync(join(root, "henxels.yaml"), "henxels: []\n", "utf8");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n_temp/", "utf8");
  const report = scaffoldBrain(root, "2026-01-02", "fixturebrain000000000");
  expect(readFileSync(join(root, "henxels.yaml"), "utf8")).toBe("henxels: []\n");
  expect(report.existing).toEqual(["henxels.yaml"]);
  expect(report.fragment).toBe(contractFragment());
  expect(report.fragment!.startsWith("  # --- the brainpick brain")).toBe(true);
  expect(report.fragment).toContain("One journal file per DAY");
  expect(report.gitignore).toBe("appended");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n_temp/\nbrainpick.local.toml\n.brainpick/\n_todo.md\n");
});

// -- init --template brain -----------------------------------------------------------

test("init --template brain scaffolds then compiles", async () => {
  const root = join(tempDir(), "repo");
  mkdirSync(root);
  const out = capture();
  expect(await runInit(root, { template: "brain", env: {}, probes: NO_BACKENDS, print: out.print })).toBe(0);
  expect(existsSync(join(root, "_brain", "skills", "using-the-brain.md"))).toBe(true);
  expect(existsSync(join(root, "_brain", ".brainpick", "manifest.json"))).toBe(true);
  expect(out.text()).toContain("brain: format 2");
  expect(out.text()).toContain(`cd ${root} && henxels init`); // not a git repository: the command is printed
  expect(out.text()).not.toContain("Gate commits on a fresh brain"); // the contract already carries the gate
});

test("init rejects an unknown template", async () => {
  const root = tempDir();
  const out = capture();
  expect(await runInit(root, { template: "wiki", env: {}, probes: NO_BACKENDS, print: out.print })).toBe(1);
  expect(out.text()).toContain("unknown template 'wiki'");
  expect(readdirSync(root)).toEqual([]);
});

test("init --template dry run writes nothing", async () => {
  const root = tempDir();
  const out = capture();
  expect(await runInit(root, { template: "brain", dryRun: true, env: {}, probes: NO_BACKENDS, print: out.print })).toBe(0);
  expect(out.text()).toContain("_brain/skills/using-the-brain.md");
  expect(readdirSync(root)).toEqual([]);
});

test.skipIf(process.platform === "win32")("init --template runs henxels init in a git repository", async () => {
  const base = tempDir();
  const root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin);
  const calls = join(base, "calls");
  writeFileSync(join(bin, "henxels"), `#!/bin/sh\npwd > '${calls}'\necho "$@" >> '${calls}'\n`, "utf8");
  chmodSync(join(bin, "henxels"), 0o755);
  const out = capture();
  const env = { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };
  expect(await runInit(root, { template: "brain", env, probes: NO_BACKENDS, print: out.print })).toBe(0);
  expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toEqual([root, "init"]);
  expect(out.text()).toContain("henxels: hooks, schema and the AGENTS.md digest installed");
  expect(statSync(join(root, "henxels.yaml")).isFile()).toBe(true);
});
