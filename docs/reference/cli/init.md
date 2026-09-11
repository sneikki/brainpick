---
type: reference
about: thing
title: "brainpick init"
description: "Detect the bundle and backends, write config, and compile T1 — the one command from zero to a living brain; --template brain scaffolds the brain first."
tags: [cli, spec]
timestamp: 2026-09-11T09:52:55Z
---

# brainpick init

`brainpick init [--root DIR]` is the onboarding command: it detects the bundle,
probes for embedding and extraction backends, writes configuration, and
compiles T1 so the brain is green at birth.

## Flags

- `--yes` — accept the opt-in choices (for example, recording `OPENAI_API_KEY` for T2).
- `--dry-run` — print what init would do without writing anything.
- `--template brain` — scaffold a format-2 [brain](../../brain.md) first (see
  [Brain template](../../brain-template.md)): the `_brain/` seeds, the first
  skill, `brainpick.toml` and the henxels contract, never overwriting a file;
  then `henxels init` in a git repository with henxels on `PATH` (otherwise the
  command is printed), then init as usual.

It writes detected endpoints into a machine-local layer (see
[Config layering and precedence](../config/layering.md)) and hands out agent
snippets.

`--root` names where the config lives, not necessarily the bundle: an existing
`brainpick.toml` with [bundle.root](../config/bundle-root.md) set is honoured,
so a [brain](../../brain.md) — config at the repo root, bundle in
`_brain/` — is detected in place, compiled into `_brain/.brainpick/`, and
announced with its [brain.format](../config/brain-format.md) and
[brain.audience](../config/brain-audience.md) plus the read order
(`skills/` first). The config itself is never rewritten; a missing
[bundle.id](../config/bundle-id.md) is suggested, not written. When no bundle
is found at all, init names both starters — `brainpick init --template brain`
for a brain and henxels' `okf-llm-wiki` for a plain wiki (see
[Brain template](../../brain-template.md)). This is the [onboarding](../../onboarding.md) concept made concrete;
run [brainpick integrate](integrate.md) next to wire a harness, and
[brainpick doctor](doctor.md) if anything looks off. Back to [CLI reference](../../reference-cli.md).
