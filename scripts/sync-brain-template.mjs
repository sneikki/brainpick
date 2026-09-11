#!/usr/bin/env node
/**
 * Sync the canonical brain template into each engine's shipped copy.
 *
 * integrations/brain-template/  (the ONE source of truth, spec/85)
 *   → packages/python/src/brainpick/_brain_template/   (pip package-data)
 *   → packages/node/brain-template/                     (npm `files`)
 *
 * Each engine resolves its shipped copy at runtime (installed wheels/tarballs
 * have no repo root); the parity tests in both engines assert the shipped tree
 * is byte-identical to this canonical. Run this after editing the canonical.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = join(repo, 'integrations', 'brain-template');

if (!existsSync(canonical)) {
  console.error(`no canonical brain template at ${canonical}`);
  process.exit(1);
}

const targets = [
  join(repo, 'packages', 'python', 'src', 'brainpick', '_brain_template'),
  join(repo, 'packages', 'node', 'brain-template'),
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true }); // a file removed from the canonical leaves no stale copy
  cpSync(canonical, target, { recursive: true });
  console.log(`synced: ${target}`);
}
