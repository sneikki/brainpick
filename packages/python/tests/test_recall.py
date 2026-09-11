"""brainpick recall (spec/72): prompt-time memory for harness hooks."""
import io
import json
import shutil
import tempfile
from pathlib import Path

import pytest

from brainpick.cli import main
from brainpick.compile.pipeline import run_compile
from brainpick.recall import extract_terms, gated, parse_payload, render, session_file

from conftest import FIXTURE_BUNDLES

HEADER = ("memories matching this prompt (each shown once per session; "
          "brain_read(path) opens the whole doc):")
DAY = (
    "# 2026-06-02\n\n## 2026-06-02\n\n"
    "* **11:15** `kuu` · note — the ferry timetable changed for the autumn.\n\n"
    "* **09:00** `kuu` · note — the tide gauge at the harbour logged a spring flood.\n"
    "  The water stood a metre above the pier.\n"
)
FLOOD = "What did the tide gauge at the harbour log about the spring flood?"


def hit(path, title="T", description="", snippet=None):
    return {"path": path, "title": title, "description": description, "snippet": snippet}


# -- the query -----------------------------------------------------------------------


def test_terms_match_each_pattern_separately_then_sort_and_cap():
    prompt = ("Deploy `pipeless core` via deploy-prod: SHAI-127 broke run_compile in brainSearch "
              "and brain-recall.sh, see AGENTS.md and the ID")
    # union of the six patterns: the backtick span, four hyphenated compounds' worth, snake,
    # camel, all-caps SHAI and AGENTS (ID is too short), two file names — ten, sorted by code
    # point (uppercase first, '-' before 'S'), the first eight kept
    assert extract_terms(prompt) == [
        "AGENTS", "AGENTS.md", "SHAI", "SHAI-127",
        "brain-recall", "brain-recall.sh", "brainSearch", "deploy-prod",
    ]


def test_terms_use_an_ascii_word_boundary():
    # a non-ASCII letter is not a word character for either regex engine: "xÄBCD" holds
    # the all-caps token BCD (Python's default Unicode \b would find none)
    assert extract_terms("xÄBCD and more words here") == ["BCD"]
    assert extract_terms("no identifiers in this plain prompt at all") == []


@pytest.mark.parametrize("prompt, closed", [
    ("/review the whole branch for me now", True),
    ("ok run it", True),
    ("one two three four five", True),
    ("one two three four five six", False),
    ("  spaced   one two three four five six  ", False),
])
def test_the_gate(prompt, closed):
    assert gated(prompt) is closed


def test_parse_payload_reads_three_fields():
    full = {"prompt": "a b c d e f", "session_id": "s1", "hook_event_name": "BeforeAgent", "cwd": "/x"}
    assert parse_payload(full) == ("a b c d e f", "s1", "BeforeAgent")
    assert parse_payload({"prompt": "a b c d e f"}) == ("a b c d e f", None, "UserPromptSubmit")
    assert parse_payload({"prompt": "a b c d e f", "session_id": ""}) == ("a b c d e f", None, "UserPromptSubmit")
    for bad in (None, [], "text", {"prompt": 3}, {}):
        assert parse_payload(bad) is None


# -- once per session ----------------------------------------------------------------


def test_session_file_location_and_sanitizing(tmp_path):
    assert session_file(None, {}) is None
    assert session_file("a/../b c", {"BRAINPICK_RECALL_STATE_DIR": str(tmp_path)}) == tmp_path / "a____b_c"
    xdg = {"XDG_RUNTIME_DIR": "/run/user/1"}
    assert session_file("s-1", xdg) == Path("/run/user/1") / "brainpick" / "recall" / "s-1"
    assert session_file("s", {}) == Path(tempfile.gettempdir()) / "brainpick-recall" / "s"


# -- rendering -----------------------------------------------------------------------


def test_render_quotes_entries_and_pages_then_points():
    hits = [
        hit("journals/2026-06-02.md", "2026-06-02", "", "* **09:00** `kuu` · note — the flood.\n  more"),
        hit("maa.md", "Maa", "The blue\nworld.", "# Maa The earth"),
        hit("kuu.md", "Kuu", "", "# Kuu tides"),
        hit("aurinko.md", "Aurinko", "The star.", None),
    ]
    entries = {("journals/2026-06-02.md", "09:00"): "* **09:00** `kuu` · note — the flood.\n  more lines"}
    context, keys = render("brain", hits, lambda path, hhmm: entries.get((path, hhmm), ""), set())
    assert context == (
        f"brain {HEADER}\n\n"
        "### journals/2026-06-02.md (09:00)\n* **09:00** `kuu` · note — the flood.\n  more lines\n\n"
        "### maa.md — Maa\nThe blue world.\n↳ # Maa The earth\n\n"
        "### aurinko.md — Aurinko\nThe star.\n\n"
        "Further hits (pointers only):\n- kuu.md — Kuu: # Kuu tides\n"
    )
    assert keys == ["journals/2026-06-02.md#09:00", "maa.md", "kuu.md", "aurinko.md"]


def test_render_caps_quoted_blocks_and_skips_seen_keys():
    hits = [hit(f"p{i}.md", f"P{i}", "desc") for i in range(7)] + [hit("e.md", "E", "", "* **10:00** x")]
    context, keys = render("b", hits, lambda path, hhmm: "* **10:00** x", {"p0.md"})
    assert [line for line in context.splitlines() if line.startswith("### ")] == [
        f"### p{i}.md — P{i}" for i in range(1, 6)
    ]
    assert context.endswith("Further hits (pointers only):\n- p6.md — P6\n- e.md — E: * **10:00** x\n")
    assert "p0.md" not in context and "p0.md" not in keys
    assert keys[-1] == "e.md#10:00"


def test_render_points_at_an_entry_it_cannot_read_and_prints_nothing_without_hits():
    context, _ = render("b", [hit("gone.md", "Gone", "", "* **08:00** x")], lambda path, hhmm: "", set())
    assert context.endswith("Further hits (pointers only):\n- gone.md — Gone: * **08:00** x\n")
    assert render("b", [], lambda path, hhmm: "", set()) == (None, [])
    assert render("b", [hit("a.md")], lambda path, hhmm: "", {"a.md"}) == (None, [])


# -- the command ---------------------------------------------------------------------


@pytest.fixture
def brain(tmp_path, monkeypatch):
    root = tmp_path / "kotiaurinko"
    shutil.copytree(FIXTURE_BUNDLES / "kotiaurinko", root)
    (root / "paivakirja").mkdir()
    (root / "paivakirja" / "2026-06-02.md").write_text(DAY, encoding="utf-8")
    run_compile(root)
    monkeypatch.setenv("BRAINPICK_RECALL_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("BRAINPICK_QUERY_LOG_DIR", str(tmp_path / "queries"))
    return root


def recall(monkeypatch, capsys, root, payload):
    stdin = payload if isinstance(payload, str) else json.dumps(payload)
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    assert main(["recall", "--root", str(root)]) == 0
    return capsys.readouterr()


def test_recall_quotes_the_matching_journal_entry_once_per_session(brain, monkeypatch, capsys):
    out = recall(monkeypatch, capsys, brain, {"prompt": FLOOD, "session_id": "s-1"}).out
    line = json.loads(out)
    assert out == json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n"  # one compact line
    assert line["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    context = line["hookSpecificOutput"]["additionalContext"]
    assert context.startswith(f"kotiaurinko {HEADER}\n\n")
    assert ("### paivakirja/2026-06-02.md (09:00)\n"
            "* **09:00** `kuu` · note — the tide gauge at the harbour logged a spring flood.\n"
            "  The water stood a metre above the pier.\n\n") in context
    assert "ferry" not in context
    assert (brain.parent / "state" / "s-1").read_text(encoding="utf-8").splitlines()[0] == "paivakirja/2026-06-02.md#09:00"
    logged = json.loads((brain.parent / "queries" / "recall-s-1.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert logged["situation"] == FLOOD and logged["terms"] == []

    again = recall(monkeypatch, capsys, brain, {"prompt": FLOOD, "session_id": "s-1"}).out
    assert "paivakirja/2026-06-02.md (09:00)" not in again  # already in this session's context


def test_recall_without_a_session_keeps_no_state_and_echoes_the_event(brain, monkeypatch, capsys):
    payload = {"prompt": FLOOD, "hook_event_name": "BeforeAgent"}
    first = json.loads(recall(monkeypatch, capsys, brain, payload).out)
    second = json.loads(recall(monkeypatch, capsys, brain, payload).out)
    assert first == second and first["hookSpecificOutput"]["hookEventName"] == "BeforeAgent"
    assert not (brain.parent / "state").exists()


@pytest.mark.parametrize("stdin", [
    "not json", "[]", json.dumps({"prompt": "ok run it"}),
    json.dumps({"prompt": "/review this whole branch for me please"}),
])
def test_recall_is_silent_on_gated_or_unreadable_input(brain, monkeypatch, capsys, stdin):
    assert recall(monkeypatch, capsys, brain, stdin).out == ""


def test_recall_on_an_uncompiled_bundle_prints_the_reason_to_stderr_only(tmp_path, monkeypatch, capsys):
    shutil.copytree(FIXTURE_BUNDLES / "kotiaurinko", tmp_path / "raw")
    captured = recall(monkeypatch, capsys, tmp_path / "raw", {"prompt": "how do the tides of maa follow kuu"})
    assert captured.out == ""
    assert "compile" in captured.err
