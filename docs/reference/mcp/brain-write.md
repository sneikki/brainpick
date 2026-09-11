---
type: reference
about: thing
title: "brain_write"
description: "The one guarded write path — resolve, atomic write, henxels referee, rollback or recompile — with base_sha optimistic concurrency and a merge ladder."
tags: [mcp, agents]
timestamp: 2026-09-11T06:36:05Z
---

# brain_write

`brain_write({doc, content, mode?, meta?, base_sha?})` is the sanctioned
two-argument exception. Behind a federated server
([federation](../../federation.md)) `doc` may be `alias:path`; an unqualified
one writes to the brain the working directory is in, and without one the call
declines naming the aliases — it never guesses a target. `mode ∈ create|replace|append_section|add_entry` (default
`create`; `add_entry` takes ONE `* ` journal entry, stamps its `**HH:MM**` head
with the server's local clock — replacing any time the writer led with — and
slots it into the newest-first day file, creating a `YYYY-MM-DD` day when
missing; never echo a day back to add a line). The flow: resolve `doc` to a
kebab-case bundle path (rejecting traversal), compose the doc and stamp its
`timestamp` with the server's clock, write atomically, run the henxels contract
against that path, roll back with the instruction *verbatim* on violation, else
recompile incrementally and emit the delta.

**Frontmatter as data (`meta`):** an object of frontmatter fields — a string, a
list of strings, or `null` to remove the key — that the server serializes to
YAML (plain when safe, else a JSON-quoted string; lists as `[a, "b: c"]`).
`content` is then the body alone. On `replace` a body-only `content` keeps the
page's frontmatter; `meta` keys are rewritten in place, absent ones appended,
and every other line of the block is kept byte for byte. `timestamp` is never
the writer's: a `timestamp` in `meta` is ignored and one inside `content` is
overwritten.

**Optimistic concurrency:** pass `base_sha` and, if it no longer matches, the
server refuses and returns a conflict — optionally with a `merged` proposal
(`three-way`, then an `llm` merge via [models.extraction](../config/models-extraction.md),
else manual). It is exposed only when [serve.writes](../config/serve-writes.md)
is `guarded` and, off localhost, only with a token.

This is the [guarded writes](../../guarded-writes.md) path; its HTTP face is
`PUT /api/docs` in [Spec: REST API](../spec/rest-api.md). Back to [MCP tool reference](../../reference-mcp.md).
