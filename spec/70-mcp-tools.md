# MCP tools

Both engines expose the same six tools, verbatim, over stdio
(`brainpick mcp`), streamable HTTP (`/mcp`), and legacy SSE (`/sse`).
Small-model ergonomics are normative: at most one required argument
(`brain_write` is the sanctioned exception — `doc` and `content`),
unknown enum values fall back to defaults with a note (never an error),
every result carries a `hint` string naming a sensible next call, and every
tool accepts `budget_tokens` (int; chars/4 estimate; results are shaped to
fit — descriptions survive first, snippets/bodies are trimmed, and a
truncated result says so and how to get the rest).

When one server fronts several brains (spec/75), every path in these
payloads is qualified `alias:path`, `brain_search`/`brain_overview` take
`scope`, and `brain_overview` adds `brains`; a single-brain server emits
exactly the shapes below.

## brain_overview({scope?, budget_tokens?})

No required args. → `{"bundle", "counts": {"docs", "edges", "tags",
"orphans", "ghosts"}, "tiers", "tree": [{"group", "docs": [{"path",
"title", "description"}]}], "top_ghosts": [{"target", "count"}],
"similarity_gaps_open_count", "hint"}`.
`top_ghosts` is the write-next queue — up to 5 ghost link targets, highest
reference count first (target path tie-break), always present (`[]` when
there are none), never subject to budget trimming (bounded size already).
`similarity_gaps_open_count` (spec/45) is the count of unresolved
similarity-gap pairs — always present, `0` when T2 or the module is off,
never budget-trimmed. Default budget 800.

## brain_search({situation, terms, mode?, limit?, scope?, budget_tokens?})

Two inputs, one per engine (spec/50): `situation` (required) is the episode in
full sentences and feeds the semantic retriever; `terms` (required, may be `[]`)
is a list of identifiers verbatim; the keyword retriever sees the terms and the
situation, the semantic retriever only the situation (spec/50). Under `auto`
both rankings are RRF-fused and deduped; `keyword` runs the keyword retriever
alone, `semantic` the semantic one, `graph` the situation. There is no free-form `query` on the tool: an agent
cannot search with one string and hope it suits both engines. Engines keep a
`query` form of the payload for the CLI, REST and tests. Default `limit` 10.
`mode ∈ auto|keyword|semantic|graph` (default `auto`). The tool description MUST tell the agent what each input wants: `keyword` an identifier verbatim (ticket id, error string, symbol, file name), `semantic` the situation in full sentences, and that an identifier plus a situation is two queries whose hits are unioned — `auto` fuses both engines over one string and suits only a string that fits both. → `{"hits":
[{"path", "title", "description", "score", "why", "snippet"}], "used_modes",
"degraded_from", "truncated", "hint"}`. Descriptions and snippets only —
never full bodies. `why` is one clause naming the match reason; `snippet`
is the retriever's evidence (≤ ~240 chars: the keyword window, or the
nearest chunk from its first whole line for a semantic hit — the overlap's
partial line and heading lines skipped, and a column-0 list item that starts
near the top of the chunk opens it, so a log entry is shown from its head;
`null` when there is none), so a
long log-shaped doc such as a journal day names the entry that matched, not
just its title. Default budget 1200.

## The query log

Every `brain_search` call is appended raw — one JSON line: `ts`, `brain`,
`situation`, `terms`, `mode`, `limit`, `scope`, `used_modes`,
`degraded_from`, `hits` (paths) — to one file per session,
`<session_id>.jsonl`, under `$BRAINPICK_QUERY_LOG_DIR`, else
`$XDG_STATE_HOME/brainpick/queries` (default `~/.local/state/brainpick/queries`).
The session id is the server process's (one per agent session under stdio),
or the one a CLI caller passes with `--session`. `BRAINPICK_QUERY_LOG=0`
disables. Nothing is aggregated by the engine: the log exists so that "do
agents search with sentences or with keyword lists" is answered from the
record.

## brain_read({doc, sections?, budget_tokens?})

`outline` lists the headings and, for a log-shaped doc, every entry head
(`* **HH:MM** …`, trimmed to 120 chars). A `sections` item that is a time
(`"05:30"`) returns that entry — the bullet with its continuation lines up
to the next entry or heading — so a journal day is read one entry at a
time, not 12k tokens at once.

`doc` resolves forgivingly: exact path → unique file stem → fuzzy title;
an ambiguous resolution returns `{"disambiguation": [{"path", "title"}]}`
instead of content. → `{"path", "frontmatter", "outline": ["## …"],
"content", "neighbors": {"in": [...], "out": [...]}, "truncated", "hint"}`
where neighbor entries are `{"path", "title"}`. Over budget → outline +
leading excerpt + hint to request `sections`. Default budget 2000.

## brain_neighbors({doc, depth?, layer?, budget_tokens?})

`depth` 1–3 (default 1), `layer ∈ links|entities|both` (default `links`;
`entities` degrades to `links` with `degraded_from` until T3). →
`{"center", "nodes": [{"path", "title", "description", "distance"}],
"edges": [{"source", "target", "kind"}], "hint"}`. Default budget 800.

## brain_write({doc, content, mode?, meta?, base_sha?})

`mode ∈ create|replace|append_section|add_entry` (default `create`). The guarded
write path:

1. Resolve `doc` to a bundle-relative kebab-case `.md` path (reject
   traversal outside the bundle).
2. Compose the doc: apply `mode` and `meta` (below), then stamp the
   frontmatter `timestamp` with the server's current UTC time,
   `YYYY-MM-DDTHH:MM:SSZ` (replacing the key's line, or appending the key
   when the block lacks it; a doc with no frontmatter block — journals and
   the OKF reserved `index.md`/`log.md` are frontmatter-free by contract —
   is left untouched).
3. Write atomically (temp + rename), then run the bundle's henxels
   contract against that path (when a contract governs the bundle — at its
   root or in a directory above it, the way henxels itself resolves one).
   The referee sees the stamped doc, so a contract that requires
   `timestamp`, or its bump on change, is satisfied by the server.
4. Violations → restore the previous state and return `{"ok": false,
   "instruction": "<henxels output verbatim>"}`.
5. Pass → trigger an incremental compile, emit the delta. →
   `{"ok": true, "path", "seq", "hint"}`.

**Server-owned clocks**: the writer never supplies a time. Models do not
know the wall clock and invent one, so every time in a written doc comes
from the server: the frontmatter `timestamp` (step 2; any `timestamp` the
writer sent is overwritten) and the `add_entry` head (below). Brainpick
does not backfill history through this tool; an importer writing past
episodes writes files and compiles.

**`meta`** (optional): the frontmatter as data, so the writer never
serializes YAML. An object whose keys match `[A-Za-z_][A-Za-z0-9_-]*` and
whose values are a string, a list of strings, or `null` (remove the key);
anything else returns `{"ok": false, "instruction"}` and writes nothing. A
`timestamp` key is ignored (server-owned). `{}` is the same as omitting it.

- **Base block** (`create`, `replace`). When `content` opens with a frontmatter
  block, that block is the base and the rest of `content` is the body (a
  full-doc write, unchanged from before `meta` existed). Otherwise `content`
  is the body and the base is, for `replace`, the previous doc's block — so a
  body-only `replace` keeps the page's frontmatter, with or without `meta` —
  and for `create` none.
- **Merge.** The base block is kept byte for byte except the top-level keys
  `meta` names. A top-level key is a column-0 line `key:`; its span runs to
  the next such line, taking indented and `- ` continuation lines with it. A
  named key present in the base is rewritten in place (or its span dropped
  for `null`); a named key absent from it is appended, in `meta`'s order.
- **Serialization.** One line per key. A string is written plain when it
  matches `^[A-Za-z][A-Za-z0-9 ._/()+-]*$`, does not end in a space and is
  not (case-insensitively) `true|false|yes|no|on|off|y|n|null`; otherwise as
  a JSON string literal (`"…"`, non-ASCII unescaped — valid YAML
  double-quoted). A list is a flow sequence, `key: [a, "b: c"]`, each item
  by the same rule; an empty list is `key: []`.
- **Output.** A block is emitted when the base has one or `meta` is non-empty:
  `---\n<block>\n---\n` followed by the body — the body verbatim when it came
  from under `content`'s own block, else a blank line and the body with its
  leading newlines stripped.
- `append_section` appends `content` to the previous body, as without `meta`,
  and merges `meta` into the previous block. `add_entry` rejects a non-empty
  `meta` with an instruction: day files are frontmatter-free.

**`add_entry`**: `content` is exactly ONE log entry — a column-0 `* ` list
item — and the server places it in the day file named by `doc`. The entry's
head is the server's: the server writes `* **HH:MM** ` with its local
wall-clock time (24-hour), replacing a `**HH:MM**` the writer led with, or
inserting it after `* ` when there is none. Placement is newest first: after
every entry with a later time, before the first with the same or an earlier
one; a file without entries gets it after its head. A missing day file is
created as `# <stem>` / `## <stem>` / the entry, and only when the stem is
`YYYY-MM-DD`; any other shape returns `{"ok": false, "instruction"}` and
writes nothing. The rest of the path (henxels, recompile, `base_sha`) is
unchanged. This exists because a day file is newest-first, so
`append_section` cannot add to it and `replace` would make the writer echo
the whole day back through the call — the lost-update and token cost that
mode removes.

**Optimistic concurrency (`base_sha`)**: writers SHOULD pass the sha256 of
the doc content they last read (available from the manifest, `docs.jsonl`,
or a future read response). When `base_sha` is present and differs from the
current file's sha256, the server MUST NOT write. It returns
`{ok: false, conflict: true, current_sha, theirs: <current content,
budget-shaped>, instruction: "the doc changed since you read it — re-read,
reconcile, retry with the new base_sha"}` — plus, when resolution is
possible, `merged: {content, strategy}` as a PROPOSAL (never auto-applied):

1. `strategy: "three-way"` — mechanical merge when base is known (git
   history or cached) and the edits do not overlap;
2. `strategy: "llm"` — a single-shot smart merge of base/theirs/yours
   through the configured `[models.extraction]` chat model, when one is
   configured — prose merges badly mechanically, so the model the brain
   already has doubles as the merge tool;
3. neither available → conflict response without `merged` (manual path).

Edge semantics: a doc DELETED since it was read conflicts with
`current_sha: null, theirs: null`. The `base_sha` comparison is evaluated
first, but a matching `base_sha` does not override `create`'s no-clobber
rule. Omitting `base_sha` preserves today's last-write-wins (writes stay
serialized server-side either way).

Servers expose `brain_write` only when config `[serve] writes = "guarded"`
(default) and, on non-localhost binds, only with a valid bearer token.

## brain_show({nodes?, focus?, mode?, annotation?, clear?})

Agent-driven presentations — spotlight a subgraph, fly the camera to `focus`,
switch `mode`, and caption it, pushed LIVE to every open UI (the agent side
reaching across to the human side). Every argument is optional; `nodes` accept
doc paths (fuzzy/kebab-resolved like `brain_read`) and entity names, unresolved
entries are dropped and listed, `focus` defaults to the first resolved node, and
an empty call or `clear: true` clears the current presentation. → `{"ok": true,
"shown": <resolved count>, "dropped": [<unresolved>], "seq", "hint"}` where `seq`
is a monotonic PRESENTATION counter distinct from the manifest seq. Unlike
`brain_write` it is ephemeral and advisory — it never writes the brain, so it is
NOT behind `[serve] writes`, only the normal auth. The presentation payload
shape, the `brain.show` live event, and `POST /api/show` are the contract of
`95-presentations.md`.

## Resources

`brain://index` (the generated index block) and `brain://doc/{+path}` (raw
document content). Optional in 0.1; hosts without resource support lose
nothing — the tools cover everything.
