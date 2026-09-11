"""`brainpick recall` (spec/72): prompt-time memory for harness hooks.

A harness pipes its prompt-hook payload in; recall searches the brain with the prompt
as the situation and the prompt's identifiers as terms, and prints the matching
memories as hook context — each one once per session. MCP makes the brain available;
this makes it consulted without the agent deciding to search.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Callable, Mapping

from brainpick.mcp_server import _brain_name, _extract_sections, _load_doc, search_payload
from brainpick.querylog import log_query

MIN_WORDS = 6
QUOTED_MAX = 5
ENTRY_CHARS = 1500
MAX_TERMS = 8
DEFAULT_EVENT = "UserPromptSubmit"
HERMES_EVENT = "pre_llm_call"  # Hermes' shell hook: the prompt is extra.user_message
HEADER = ("{name} memories matching this prompt (each shown once per session; "
          "brain_read(path) opens the whole doc):")

# ASCII classes and an ASCII \b, so the Node engine's regexes agree (spec/72).
TERM_PATTERNS = tuple(re.compile(pattern, re.ASCII) for pattern in (
    r"`[^`]+`",
    r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+",
    r"[A-Za-z]+_[A-Za-z0-9_]+",
    r"[a-z]+[A-Z][A-Za-z0-9]+",
    r"\b[A-Z]{3,}[0-9]*\b",
    r"[A-Za-z0-9_-]+\.(?:md|py|ts|js|go|sh|json|toml|yaml|yml)\b",
))
_ENTRY_HEAD = re.compile(r"^\* \*\*(\d{2}:\d{2})\*\*")
_UNSAFE_SESSION = re.compile(r"[^A-Za-z0-9_-]")


def parse_payload(payload: object) -> tuple[str, str | None, str] | None:
    """(prompt, session_id or None, hook event) — None when there is no string prompt.
    Two dialects (spec/72): the Claude Code protocol's `prompt`, and Hermes'
    `extra.user_message` when the event is `pre_llm_call`."""
    if not isinstance(payload, dict):
        return None
    event = payload.get("hook_event_name")
    event = event if isinstance(event, str) else DEFAULT_EVENT
    if event == HERMES_EVENT:
        extra = payload.get("extra")
        prompt = extra.get("user_message") if isinstance(extra, dict) else None
    else:
        prompt = payload.get("prompt")
    if not isinstance(prompt, str):
        return None
    session = payload.get("session_id")
    return prompt, session if isinstance(session, str) and session else None, event


def gated(prompt: str) -> bool:
    """A slash command or an acknowledgement carries no situation to recall for."""
    return prompt.startswith("/") or len(prompt.split()) < MIN_WORDS


def extract_terms(prompt: str) -> list[str]:
    found = {match.group(0).replace("`", "") for pattern in TERM_PATTERNS for match in pattern.finditer(prompt)}
    return sorted(term for term in found if len(term) > 2)[:MAX_TERMS]


def session_file(session: str | None, env: Mapping[str, str]) -> Path | None:
    if not session:
        return None
    if env.get("BRAINPICK_RECALL_STATE_DIR"):
        base = Path(env["BRAINPICK_RECALL_STATE_DIR"])
    elif env.get("XDG_RUNTIME_DIR"):
        base = Path(env["XDG_RUNTIME_DIR"]) / "brainpick" / "recall"
    else:
        base = Path(tempfile.gettempdir()) / "brainpick-recall"
    return base / _UNSAFE_SESSION.sub("_", session)


def _flat(text: str | None) -> str:
    return (text or "").replace("\n", " ").replace("\x1f", " ")


def render(name: str, hits: list[dict], entry_of: Callable[[str, str], str],
           seen: set[str]) -> tuple[str | None, list[str]]:
    """(context or None, the keys rendered) — hits in rank order, 5 quoted, the rest pointers."""
    quoted: list[str] = []
    pointers: list[str] = []
    keys: list[str] = []
    for hit in hits:
        path, title = hit["path"], _flat(hit.get("title"))
        description, snippet = _flat(hit.get("description")), _flat(hit.get("snippet"))
        head = _ENTRY_HEAD.match(snippet)
        key = f"{path}#{head.group(1)}" if head else path
        if key in seen or key in keys:
            continue
        keys.append(key)
        if len(quoted) < QUOTED_MAX:
            if head:
                entry = entry_of(path, head.group(1))
                if entry:
                    quoted.append(f"### {path} ({head.group(1)})\n{entry}")
                    continue
            elif description:
                quoted.append(f"### {path} — {title}\n{description}" + (f"\n↳ {snippet}" if snippet else ""))
                continue
        pointers.append(f"- {path} — {title}" + (f": {snippet}" if snippet else ""))
    if not quoted and not pointers:
        return None, keys
    context = HEADER.format(name=name) + "\n\n" + "".join(block + "\n\n" for block in quoted)
    if pointers:
        context += "Further hits (pointers only):\n" + "".join(line + "\n" for line in pointers)
    return context, keys


def _entry_text(state, path: str, hhmm: str) -> str:
    record = next((r for r in state.records if r["path"] == path), None)
    if record is None:
        return ""
    _, body = _load_doc(state, record)
    return _extract_sections(body, [hhmm]).rstrip()[:ENTRY_CHARS]


def recall_line(state, name: str, prompt: str, session: str | None, event: str,
                limit: int = 10, env: Mapping[str, str] | None = None) -> str | None:
    """Everything past the gate and the loaded brain: the line to print, or None."""
    env = os.environ if env is None else env
    terms = extract_terms(prompt)
    result = search_payload(state, None, "auto", limit, budget_tokens=sys.maxsize,
                            terms=terms, situation=prompt)
    log_query(f"recall-{session or 'nosession'}", _brain_name(state),
              {"situation": prompt, "terms": terms, "mode": "auto", "limit": limit, "scope": None}, result)
    store = session_file(session, env)
    seen = set(store.read_text(encoding="utf-8").splitlines()) if store and store.is_file() else set()
    context, keys = render(name, result["hits"], lambda path, hhmm: _entry_text(state, path, hhmm), seen)
    if store is not None and keys:
        store.parent.mkdir(parents=True, exist_ok=True)
        with store.open("a", encoding="utf-8") as handle:
            handle.write("".join(key + "\n" for key in keys))
    if context is None:
        return None
    if event == HERMES_EVENT:
        output = {"context": context}
    else:
        output = {"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}}
    return json.dumps(output, ensure_ascii=False, separators=(",", ":"))
