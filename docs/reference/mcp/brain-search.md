---
type: reference
about: thing
title: "brain_search"
description: "Two-input search — terms for the keyword engine, situation for the semantic one, fused — returning titles, descriptions and the matched snippet, never full bodies."
tags: [mcp, agents]
timestamp: 2026-09-09T07:00:00Z
---

# brain_search

`brain_search({situation, terms, mode?, limit?, scope?, budget_tokens?})` takes
two inputs, one per engine: `situation` — the episode in one or two full
sentences (what you are doing, what happened, what you expected, which project)
— feeds the semantic retriever, and `terms` — identifiers verbatim (ticket ids,
error strings as printed, function/env/flag/file names, proper nouns; `[]` when
nothing has a name yet) — feeds the keyword retriever. A keyword list gives the
embedder nothing and a sentence gives BM25 only function words, which is why the
tool has no single free-form query. It returns `hits` of `{path, title,
description, score, why, snippet}` — descriptions and the matched snippet only,
never full bodies — plus `used_modes`, `degraded_from`, `truncated` and a
`hint`. `mode ∈ auto|keyword|semantic|graph` (default `auto`, the RRF fusion of
both rankings); an unknown mode falls back to `auto` with a note. `why` is one
clause naming the match reason. Default `limit` 10, budget 1200. A hit is a
pointer: read every plausibly relevant one with `brain_read` — a journal hit is
titled by its date, so judge it by the snippet, which opens at the head of the
matched entry; `brain_read(path, sections=["HH:MM"])` then reads that entry
alone. Function words are dropped from the query (a closed English stopword
list, both engines) so a sentence no longer matches every page on "the".
Every call is appended raw to the session's query log
(`~/.local/state/brainpick/queries/<session>.jsonl`).

Behind a federated server ([federation](../../federation.md)) every brain in
`scope` — `all` (default), `here`, `me`, or a comma-separated alias list — is
searched, hits are merged by rank (scores are not comparable across brains,
so `hits` is rank-ordered and each keeps its brain's native `score`), each
carries its `brain`, paths become `alias:path`, and the answer adds `searched`
and `contributing`.

Its modes and honest degradation are [search modes](../../search-modes.md); its
CLI mirror is [brainpick search](../cli/search.md). Back to [MCP tool reference](../../reference-mcp.md).
