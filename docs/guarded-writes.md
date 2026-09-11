---
type: article
about: concept
title: Guarded writes
description: brain_write lets agents add knowledge through MCP, but nothing touches the brain without passing the henxels contract first.
tags: [writes, governance]
timestamp: 2026-09-11T06:36:05Z
---

# Guarded writes

Agents with only file access already write to a brain under henxels' git
hooks. But agents reaching the brain remotely — over streamable HTTP or SSE —
have no filesystem, so brainpick ships a write path from day one:
`brain_write`, the fifth of the [MCP tools](mcp-tools.md).

The guarantee is the principle "writes go through the suspenders": nothing
enters the brain unvalidated. The flow is deliberately boring:

1. Resolve the target to a kebab-case bundle path (create, replace,
   append-section, or add-entry mode).
2. Compose the doc and stamp its `timestamp` frontmatter with the server's
   clock (a doc with no frontmatter block, such as a journal or a reserved
   `index.md`/`log.md`, gets no stamp).
3. Write atomically, then run the henxels contract against exactly that
   path — the referee judges the stamped doc.
4. On violation: roll back and return henxels' instruction *verbatim* — the
   agent gets steering ("one concept per page, `type` from this list"), not
   a stack trace.
5. On pass: trigger an incremental run of
   the [compile pipeline](compile-pipeline.md), and broadcast the change
   over [live deltas](live-deltas.md) — a remote agent's accepted write
   makes the [holographic brain](holographic-brain.md) visibly fire.

Every time in a written doc is the server's. A model does not know the wall
clock and invents one when asked, so the writer never supplies a time: the
`timestamp` is stamped before the referee runs (a contract that requires it is
met by the server, and a `timestamp` the writer sent is overwritten), and an
`add_entry` journal entry gets its `**HH:MM**` head from the server's local
clock. The frontmatter itself can arrive as data too — `brain_write`'s `meta`
object (`type`, `title`, `description`, `tags`, …) is serialized to YAML by the
server and merged key by key into the page's existing block, so a writer that
only edits a body never retypes, or mis-quotes, the frontmatter.

Writes are configuration-gated (`guarded` or `off`) and require the bearer
token whenever the server is bound beyond localhost. The division of labor
stays clean: brainpick never re-implements validation — henxels is the
referee, brainpick is the pipeline around it.

The same guarded path has a second face now: the browser editor. `PUT
/api/docs/{path}` is the HTTP mouth of `brain_write` — the identical resolve →
atomic write → henxels referee → rollback-or-recompile → live-delta machinery,
the same `base_sha` optimistic concurrency and merge ladder, mapped onto status
codes (200 with the saved doc's new content sha, 422 carrying the contract's
instruction verbatim, 409 carrying the conflict and — when the base resolves —
its merge proposal). A companion `POST /api/assets` stores an embedded image
under the bundle's `assets/` folder (sanitized name, deduplicated by content
hash, invisible to the graph because it carries no `.md`), returning the
bundle-relative `assets/<name>` path an editor drops into a markdown image
embed. Both share the write gate — exposed only while writes are `guarded`, and
behind a token or session once the bind leaves localhost (see
[Authentication](authentication.md)). One referee, one pipeline, now two mouths:
an agent's MCP tool and a human's editor write through exactly the same
suspenders.
