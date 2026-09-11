"""The query log (spec/70): every brain_search call, raw, one JSON line per call, one file
per session — so a month later the question "do agents search with sentences or with
keyword lists?" is answered from the record, not from memory. Nothing is aggregated here.

Location: $BRAINPICK_QUERY_LOG_DIR, else $XDG_STATE_HOME/brainpick/queries (default
~/.local/state/brainpick/queries), file <session_id>.jsonl. BRAINPICK_QUERY_LOG=0 disables.
The session id is the MCP server process's (one per agent session under stdio) or the one a
CLI caller passes with --session, so a harness hook can log under its own session."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path


def new_session_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]


def log_dir() -> Path | None:
    if os.environ.get("BRAINPICK_QUERY_LOG", "1") in ("0", "false", "off", ""):
        return None
    override = os.environ.get("BRAINPICK_QUERY_LOG_DIR")
    if override:
        return Path(override)
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state) / "brainpick" / "queries"


def log_query(session_id: str, brain: str, request: dict, result: dict) -> Path | None:
    """Append one line; never raises (a log must not break a search)."""
    directory = log_dir()
    if directory is None:
        return None
    line = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "brain": brain,
        **request,
        "used_modes": result.get("used_modes"),
        "degraded_from": result.get("degraded_from"),
        "hits": [h.get("path") for h in result.get("hits", [])],
    }
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{session_id}.jsonl"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        return path
    except OSError:
        return None
