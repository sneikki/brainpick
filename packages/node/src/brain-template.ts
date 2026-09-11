/** `brainpick init --template brain` (spec/85): scaffold a format-2 brain. Twin of brain_template.py.
 *
 * The files are the canonical tree integrations/brain-template/, shipped in the npm package as
 * brain-template/ and synced by scripts/sync-brain-template.mjs; `{{today}}` and `{{bundle_id}}`
 * are the only placeholders. Nothing that exists is overwritten: an existing henxels.yaml gets
 * the brain contract as a fragment to paste instead.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { cmpStr } from "./core/canonical";
import { pySplitLines, pyStrip } from "./core/pyfmt";
import { PACKAGE_ROOT } from "./version";

export const TEMPLATES = ["brain"] as const;
const CONTRACT = "henxels.yaml";
const FRAGMENT_MARKER = "  # --- the brainpick brain";
const GITIGNORE_ENTRIES = ["_temp/", "brainpick.local.toml", ".brainpick/", "_todo.md"];

export interface ScaffoldReport {
  written: string[];
  existing: string[];
  gitignore: "created" | "appended" | null;
  fragment: string | null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The shipped template: the package copy first (installed tarballs), then the repo-root
 * canonical (dev checkout). */
export function templateRoot(): string {
  const packaged = resolve(PACKAGE_ROOT, "brain-template");
  if (isDirectory(packaged)) return packaged;
  return resolve(PACKAGE_ROOT, "..", "..", "integrations", "brain-template");
}

/** Every file the template writes, as sorted bundle-relative POSIX paths. */
export function templateFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(templateRoot(), "");
  return files.sort(cmpStr);
}

/** The brain rules of the template contract, to paste into an existing henxels.yaml. */
export function contractFragment(): string {
  const text = readFileSync(join(templateRoot(), CONTRACT), "utf8");
  return text.slice(text.indexOf(FRAGMENT_MARKER));
}

/** Append the missing entries to .gitignore: "created", "appended" or null. */
function ensureGitignored(root: string): "created" | "appended" | null {
  const path = join(root, ".gitignore");
  let existing: string | null = null;
  try {
    if (statSync(path).isFile()) existing = readFileSync(path, "utf8");
  } catch {
    existing = null;
  }
  const lines = new Set(pySplitLines(existing ?? "").map((line) => pyStrip(line)));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry) && !lines.has(entry.replace(/\/+$/, "")));
  if (missing.length === 0) return null;
  const separator = !existing || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, (existing ?? "") + separator + missing.map((entry) => entry + "\n").join(""), "utf8");
  return existing !== null ? "appended" : "created";
}

/** Write the template into `root`: the template paths written and left as they were, the
 * .gitignore outcome, and the contract to paste when henxels.yaml already existed. */
export function scaffoldBrain(root: string, today: string, bundleId: string): ScaffoldReport {
  const base = templateRoot();
  const written: string[] = [];
  const existing: string[] = [];
  for (const rel of templateFiles()) {
    const target = join(root, rel);
    if (existsSync(target)) {
      existing.push(rel);
      continue;
    }
    const text = readFileSync(join(base, rel), "utf8").replaceAll("{{today}}", today).replaceAll("{{bundle_id}}", bundleId);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
    written.push(rel);
  }
  return {
    written,
    existing,
    gitignore: ensureGitignored(root),
    fragment: existing.includes(CONTRACT) ? contractFragment() : null,
  };
}
