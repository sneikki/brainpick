---
type: reference
about: thing
title: "brainpick recall"
description: "The prompt hook: a harness pipes its hook payload in, recall searches the brain with the prompt and prints the matching memories as hook context, each once per session."
tags: [cli, spec, agents]
timestamp: 2026-09-11T08:00:32Z
---

# brainpick recall

`brainpick recall [--root DIR] [--limit N]` is a prompt hook, not a verb you
type. A harness (Claude Code's `UserPromptSubmit`, Gemini CLI's `BeforeAgent`)
pipes its hook payload in on stdin; recall searches the compiled brain and
prints one hook-output line whose `additionalContext` holds the memories that
match the prompt — or nothing. [MCP tools](../../mcp-tools.md) make the brain
available; recall makes it consulted before the agent decides anything.

- **The gate** — slash commands and prompts under six words get nothing.
- **The query** — the prompt verbatim is the `situation` (no translation, no
  model: the agent writes English queries itself), and the identifiers in it
  (backtick spans, hyphenated ids, snake_case, camelCase, ALLCAPS, file names)
  are the `terms` of one [brain_search](../mcp/brain-search.md), logged under
  `recall-<session_id>`.
- **Once per session** — a journal entry (`path#HH:MM`) or page already
  injected in the session is skipped; the keys live in
  `$BRAINPICK_RECALL_STATE_DIR`, else `$XDG_RUNTIME_DIR/brainpick/recall`.
- **The context** — up to five quoted memories (a matched journal entry whole,
  a page's description and snippet), the rest one-line pointers to
  `brain_read`.

Flags: `--root DIR` (resolved like every command, so a repo root with
`[bundle] root` works; default the current directory), `--limit N` (hits
searched, default `10`). The exit status is always 0: an unreadable payload
or an uncompiled brain prints nothing and says why on stderr, because a hook
must never break a prompt. [brainpick integrate](integrate.md) prints the
`UserPromptSubmit` registration. The contract is
[Spec: recall](../spec/recall.md). Back to [CLI reference](../../reference-cli.md).
