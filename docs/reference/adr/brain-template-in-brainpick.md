---
type: decision
about: concept
title: "ADR: the brain template lives in brainpick"
description: "Why the brain starter template moved from henxels into brainpick (brainpick init --template brain): what the template teaches depends on how brainpick writes, and a template in another repository drifted from it; henxels stays the referee of the contract the template writes."
tags: [brain-format, henxels, agents]
timestamp: 2026-09-11T09:34:00Z
---

# ADR: the brain template lives in brainpick

Supersedes [ADR: the brain format is a spec, the brain template lives in henxels](brain-template-in-henxels.md).

**Context.** That decision put the brain's scaffold in henxels and named its
cost: a design spanning two repositories, mitigated by keeping the semantics
here. The mitigation did not hold, because the template is not only layout —
its first skill teaches agents how to write, and how to write is exactly what
brainpick changed. [Guarded writes](../../guarded-writes.md) now own every
clock (the frontmatter `timestamp` and the journal entry's `**HH:MM**`),
take the frontmatter as `meta` data, and add journal entries one at a time
with `add_entry` into day files. The henxels template still told agents to
bump `timestamp` themselves and to write month files, so every brain it
scaffolded taught models to invent times that the engine then had to
overwrite. The fix belonged in a repository this project does not own, and it
could only ever be right for one version of the engine.

**Decision.** `brainpick init --template brain` scaffolds the brain: the
`_brain/` seeds, the first skill, `brainpick.toml` and the henxels contract
(`henxels.yaml`, `henxels_checks.py`). henxels keeps what it is for — the
referee: `brainpick init` runs `henxels init` afterwards, which leaves the
contract as written and installs the hooks, the schema and the `AGENTS.md`
digest. The template's files are normative bytes in
[Spec: brain format](../spec/brain-format.md), proven in both engines by the
`brain-template` conformance class. The layout stays the template's
business, never the compiler's: engines still read no folder names.

**Alternatives considered.** Fork henxels and fix the template there — rejected:
it keeps the two-repository cost and adds a second fork to track. A PR to
upstream henxels — rejected: "never write a time" is wrong for every engine
without server-owned clocks, so the upstream template cannot say it. Leaving
the template and correcting agents in instructions — rejected: the template
is what new brains start from, so the wrong instruction would keep being
reborn.

**Consequences.** Format 2 of the brain: journals are day files. brainpick
carries more text (the contract and the first skill), kept in one canonical
tree with byte-identical copies in both packages. The okf-llm-wiki template
stays in henxels — a wiki's layout does not depend on how brainpick writes.
Concepts henxels' template gains later (such as a `conventions/` folder) are
re-implemented here on their merits, not merged. Back to
[Architecture decision records](../../reference-adr.md).
