---
type: reference
about: thing
title: "models.embedding"
description: "The T2 embedding backend — kind, endpoint, model, dim and the optional task prefixes — a machine-local table that belongs in brainpick.local.toml."
tags: [config, spec]
timestamp: 2026-09-08T04:35:00Z
---

# models.embedding

`[models.embedding]` pins the T2 embedding backend explicitly, short-circuiting
detection. Keys:

- `kind` — `ollama | openai-compatible | openai | fastembed | mock`.
- `endpoint` — the backend URL.
- `model` — the embedding model name.
- `dim` — vector dimension; `0` means discover it from the first response.
- `document_prefix` / `query_prefix` — task prefixes for asymmetric models,
  default `""`. nomic-embed-text wants `"search_document: "` at index time
  and `"search_query: "` at query time; embeddinggemma wants
  `"title: none | text: "` and `"task: search result | query: "`. The
  prefix is prepended to the text sent to the model, never stored in
  `chunks.jsonl`; both land in `t2/embedding.json` so query time uses the
  same convention, and changing either is a backend change (full re-embed).

An explicit table always wins and is never re-probed; leave it empty to let the
[embedding detection](../../embedding-detection.md) ladder decide. Because it
names a local endpoint, it belongs in the machine-local layer (see
[Config layering and precedence](layering.md)). It feeds
[Spec: T2 vectors](../spec/t2-vectors.md) and the
[modules.vectors](modules-vectors.md) switch. Back to [Configuration reference](../../reference-config.md).
