# Recall

`brainpick recall` turns one user prompt into brain context before the agent
reads it. A harness runs it as a prompt hook, pipes the hook payload in, and
injects what it prints. MCP makes the brain *available*; recall makes it
*consulted* — the agent does not have to decide to search. It is a first pass
over the user's raw wording, never a replacement for the agent's own
`brain_search`: the prompt was not written as a query, and the agent that
reads the injected hits still searches with a situation and terms of its own
(spec/70).

## Invocation

`brainpick recall [--root ROOT] [--limit N]`

- `--root` resolves the way every command resolves it (spec/80: the config
  layers at `ROOT`, then the bundle `[bundle] root` names); default the
  current directory. `--limit` defaults to 10.
- stdin: one JSON object, the hook payload. stdout: one JSON object on one
  line, or nothing.
- The exit status is always 0. Any failure — an unreadable payload, a missing
  or uncompiled bundle, a search error — prints nothing to stdout and the
  reason to stderr. A prompt hook must never block or break the prompt it
  was given. A stale bundle is still searched (stale hits beat none); the
  staleness note goes to stderr.

## Input

Three fields are read; everything else is ignored:

- `prompt` — the user's prompt (string; absent or non-string = no output).
- `session_id` — the harness session (string; may be absent).
- `hook_event_name` — echoed back (default `"UserPromptSubmit"`).

This is the payload Claude Code sends to `UserPromptSubmit` and Gemini CLI to
`BeforeAgent`; any harness speaking the same hook protocol can run recall.

## The gate

Recall prints nothing when the prompt starts with `/` (a slash command) or
has fewer than 6 whitespace-separated words — an acknowledgement ("ok, run
it") carries no situation to recall for.

## The query

A recall is one two-input search (spec/50) with mode `auto`, limit `N` and no
budget trimming (the hits the search ranks are the hits rendered):

- `situation` is the prompt verbatim. Recall does not translate or rewrite
  it and calls no model: a prompt written in another language than the brain
  reaches the keyword engine only through its identifiers, and the semantic
  engine as far as the embedder is multilingual. Writing an English query is
  the agent's job (spec/70), not the hook's.
- `terms` are the identifiers in the prompt. Each pattern below is matched
  over the whole prompt separately (non-overlapping, left to right); the
  union has backticks stripped, items of 2 characters or fewer dropped,
  duplicates removed, is sorted by Unicode code point, and its first 8 are
  the terms (the classes are ASCII and `\b` is an ASCII word boundary, so
  both regex engines agree):
  1. a backtick span: `` `[^`]+` ``
  2. a hyphenated compound: `[A-Za-z0-9]+(-[A-Za-z0-9]+)+`
  3. snake_case: `[A-Za-z]+_[A-Za-z0-9_]+`
  4. camelCase: `[a-z]+[A-Z][A-Za-z0-9]+`
  5. an all-caps token: `\b[A-Z]{3,}[0-9]*\b`
  6. a file name: `[A-Za-z0-9_-]+\.(md|py|ts|js|go|sh|json|toml|yaml|yml)\b`

The search is appended to the query log (spec/70) under the session
`recall-<session_id>`, or `recall-nosession` when the payload has none.

## Once per session

A memory already injected in a session is in that session's context, so it
is not injected again. A hit's key is `<path>#<HH:MM>` when it renders as an
entry (below) and `<path>` otherwise. The keys a session has seen are kept,
one per line, in the file `<session_id>` — every character outside
`[A-Za-z0-9_-]` replaced by `_`, so no id names a path outside the directory
— under `$BRAINPICK_RECALL_STATE_DIR`, else `$XDG_RUNTIME_DIR/brainpick/recall`,
else `brainpick-recall` in the system temp directory: runtime state that may
vanish at reboot. A hit whose key is
already there is skipped entirely; every rendered key is added. A payload
without `session_id` reads and writes no state: every hit is eligible.

## Rendering

The hits are taken in rank order and each becomes one of:

- **an entry** — its snippet begins with a log-entry head `* **HH:MM**`
  (spec/50's snippet opens at the matching entry's head). The quoted text is
  that entry as `brain_read` returns it for `sections=["HH:MM"]` (spec/70),
  trailing whitespace stripped, cut to its first 1500 code points.
- **a page** — not an entry, with a non-empty description. The quoted text is
  the description, plus the snippet when there is one.
- **a pointer** — everything else, and any entry or page past the first 5
  quoted (entries and pages share that cap).

In titles, descriptions and snippets every newline and U+001F is replaced by
a space; an entry keeps its lines. The context is:

```
<name> memories matching this prompt (each shown once per session; brain_read(path) opens the whole doc):

### <path> (<HH:MM>)
<entry>

### <path> — <title>
<description>
↳ <snippet>

Further hits (pointers only):
- <path> — <title>: <snippet>
```

— the header, a blank line, then every quoted block in rank order, each
followed by a blank line (the `↳` line omitted when the page has no snippet),
then, when there are pointers, `Further hits (pointers only):` and one line
per pointer (`: <snippet>` omitted when there is none). `<name>` is the name
of the directory `--root` resolves to. When nothing is quoted and nothing is
a pointer — no hits, or every hit already seen — recall prints nothing.
Otherwise it prints one line of compact JSON (no spaces after `,` and `:`,
non-ASCII unescaped) and a newline:

```json
{"hookSpecificOutput":{"hookEventName":"<hook_event_name>","additionalContext":"<context>"}}
```

## Wiring

`brainpick integrate claude-code` adds a `UserPromptSubmit` entry to the hooks
fragment it prints (beside its `PreToolUse` graph-before-grep hook) — for the
harness's settings, which integrate never edits. The command is the launcher
the MCP snippet uses (`brainpick` as that installation reaches it), then
`recall --root <absolute root>`, shell-quoted:

```json
{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "<launcher> recall --root <absolute root>", "timeout": 15}]}]}}
```

Recall reads one brain. Recalling across the brains of a federation
(spec/75) is a later change.
