---
type: reference
about: concept
title: "Spec: recall"
description: "The normative contract for brainpick recall — the hook payload, the six-word gate, the prompt as situation and its identifiers as terms, once-per-session keys, and the exact rendered hook context."
tags: [spec, agents]
timestamp: 2026-09-11T08:52:33Z
---

# Spec: recall

`spec/72-recall.md` fixes `brainpick recall` so both engines print the same
bytes for the same prompt: the two hook dialects — the Claude Code protocol
(`prompt`, `session_id`, `hook_event_name`, answered in `hookSpecificOutput`)
and Hermes' `pre_llm_call` (`extra.user_message`, answered in `context`) — the gate (a slash command or fewer than six
words), the two-input search — the prompt verbatim as the situation, never
translated, and the identifiers six ASCII patterns lift from it as terms —
and the query-log session `recall-<session_id>`.

It specifies the once-per-session state (entry keys `path#HH:MM`, page keys
`path`, a sanitized file per session under runtime state), the three renderings
(an entry quoted as `brain_read` sections returns it, a page as its
description and snippet, everything else a pointer; five quoted at most), the
exact context text and the one-line compact JSON around it, the exit status
that is always 0, and the `UserPromptSubmit` entry `integrate claude-code`
prints. The conformance class `recall` byte-compares the output against a
golden.

The command is [brainpick recall](../cli/recall.md); the search it runs is
[Spec: MCP tools](mcp-tools.md). Back to [Spec reference](../../reference-spec.md).
