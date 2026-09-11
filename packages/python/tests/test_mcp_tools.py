"""MCP tool payloads (spec/70): budget shaping, forgiving resolution, guarded writes."""
import json
import os
import re
import subprocess
from datetime import datetime, timezone

import brainpick.mcp_server as mcp_server
from brainpick.config import load_config
from brainpick.core.canonical import sha256_hex
from brainpick.llm import MockChat
from brainpick.mcp_server import (
    neighbors_payload,
    overview_payload,
    read_payload,
    search_payload,
    tokens_of,
    write_payload,
)
from brainpick.serve.state import ServeState

from conftest import prepend_path, stage_fake_henxels, stage_t3_export

NEW_DOC = (
    "---\ntype: Concept\ntitle: Uusi kivi\ndescription: A new rock.\n---\n\n"
    "# Uusi kivi\n\nNear [Kuu](kuu.md).\n"
)
KUU_REWRITE = (
    "---\ntype: Concept\ntags: [kuu]\ntimestamp: 2026-06-15T08:30:00Z\n---\n\n"
    "# Kuu\n\nThe moon pulls the tides of [Maa](maa.md), rewritten.\n"
)


def set_clock(monkeypatch, *hhmm: str) -> str:
    """Pin the server clock (spec/70 server-owned clocks): each write reads the next
    local wall-clock time on 2026-06-02, the last one repeating. Returns the first
    instant as the frontmatter stamp it becomes."""
    instants = [datetime(2026, 6, 2, int(t[:2]), int(t[3:])).astimezone().astimezone(timezone.utc)
                for t in hhmm]
    ticks = iter(instants)
    monkeypatch.setattr(mcp_server, "_clock", lambda: next(ticks, instants[-1]))
    return instants[0].strftime("%Y-%m-%dT%H:%M:%SZ")


def make_state(root):
    state = ServeState(root, load_config(root))
    state.load()
    return state


def tree_doc_count(result):
    return sum(len(group["docs"]) for group in result["tree"])


def drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


def test_tokens_of_is_chars_over_four():
    payload = {"text": "a" * 400}
    assert tokens_of(payload) == len(json.dumps(payload, ensure_ascii=False)) // 4


def test_overview_counts_and_tree(kotiaurinko):
    result = overview_payload(make_state(kotiaurinko))
    assert result["counts"]["docs"] == 10
    assert result["counts"]["ghosts"] == 1
    assert result["bundle"] == "kotiaurinko"
    assert [g["group"] for g in result["tree"]] == ["concepts", "saaret"]
    assert result["truncated"] is False
    assert result["hint"]


def test_overview_top_ghosts_is_the_write_next_queue(kotiaurinko):
    result = overview_payload(make_state(kotiaurinko))
    assert result["top_ghosts"] == [{"target": "olematon.md", "count": 1}]


def test_overview_similarity_gaps_open_count_zero_when_artifact_absent(kotiaurinko):
    result = overview_payload(make_state(kotiaurinko))
    assert result["similarity_gaps_open_count"] == 0


def test_overview_similarity_gaps_open_count_reads_the_artifact(kotiaurinko):
    state = make_state(kotiaurinko)  # compiles first (T2 off — no artifact yet)
    (kotiaurinko / ".brainpick" / "t1" / "similarity-gaps.json").write_text(
        json.dumps({"pairs": [
            {"a": "a.md", "b": "b.md", "score": 0.9, "status": "open"},
            {"a": "c.md", "b": "d.md", "score": 0.8, "status": "dismissed"},
        ], "threshold": 0.75, "max_pairs": 50}),
        encoding="utf-8",
    )
    assert overview_payload(state)["similarity_gaps_open_count"] == 1


def test_overview_budget_trims_tree(kotiaurinko):
    state = make_state(kotiaurinko)
    full = overview_payload(state)
    slim = overview_payload(state, budget_tokens=80)
    assert slim["truncated"] is True
    assert tree_doc_count(slim) < tree_doc_count(full)


def test_search_hits_carry_the_matched_snippet(kotiaurinko):
    """A hit names WHERE in the doc the match is — the retriever's snippet (keyword
    window or the nearest chunk's head) rides along, so a long log-shaped page such
    as a journal day is not reduced to its title (spec/70)."""
    state = make_state(kotiaurinko)
    result = search_payload(state, "tides", mode="keyword")
    top = result["hits"][0]
    assert top["path"] == "kuu.md"
    assert isinstance(top["snippet"], str) and "tides" in top["snippet"].lower()
    assert len(top["snippet"]) <= 260


def test_search_hits_have_why_not_bodies(kotiaurinko):
    result = search_payload(make_state(kotiaurinko), "aurinko")
    assert {h["path"] for h in result["hits"]} == {
        "aurinko.md", "komeetta.md", "planeetat.md", "yksinainen.md",
    }
    assert set(result["hits"][0]) == {"path", "title", "description", "score", "why", "snippet"}
    assert result["used_modes"] == ["keyword"]
    assert result["degraded_from"] == "semantic"  # auto without T2 says so (spec/30)
    assert result["truncated"] is False


def test_search_why_names_matched_terms_not_whole_query(kotiaurinko):
    """issue #2: a multi-word query must not claim the WHOLE query appears in a
    doc that only matched some of its terms. The 'why' names the tokens that
    actually occur, never a term (like 'banana') that appears nowhere."""
    result = search_payload(make_state(kotiaurinko), "aurinko komeetta banana")
    assert result["hits"], "expected keyword hits for a partially-matching query"
    for hit in result["hits"]:
        why = hit["why"]
        # never echo the full query, and never claim a non-existent term matched
        assert "aurinko komeetta banana" not in why
        assert "banana" not in why
        # a keyword-ish 'mentions' reason must quote the actual matched token(s)
        if "mentions" in why:
            assert "aurinko" in why or "komeetta" in why


def test_search_budget_trims_hits(kotiaurinko):
    state = make_state(kotiaurinko)
    full = search_payload(state, "aurinko")
    slim = search_payload(state, "aurinko", budget_tokens=40)
    assert slim["truncated"] is True
    assert 1 <= len(slim["hits"]) < len(full["hits"])
    assert "budget" in slim["hint"]


def test_search_forgiving_modes(kotiaurinko):
    state = make_state(kotiaurinko)
    unknown = search_payload(state, "aurinko", mode="banana")
    assert unknown["used_modes"] == ["keyword"]
    assert unknown["degraded_from"] == "semantic"  # banana → auto → degraded without T2
    assert "fell back to auto" in unknown["hint"]
    keyword = search_payload(state, "aurinko", mode="keyword")
    assert keyword["degraded_from"] is None
    degraded = search_payload(state, "aurinko", mode="semantic")
    assert degraded["used_modes"] == ["keyword"]
    assert degraded["degraded_from"] == "semantic"


def test_search_semantic_hits_via_mock_vectors(kotiaurinko):
    (kotiaurinko / "brainpick.toml").write_text('[models.embedding]\nkind = "mock"\n',
                                                encoding="utf-8")
    state = make_state(kotiaurinko)
    assert state.manifest["tiers"]["t2"] == "fresh"
    semantic = search_payload(state, "kuu vuorovesi maa", mode="semantic")
    assert semantic["used_modes"] == ["semantic"]
    assert semantic["degraded_from"] is None
    assert semantic["hits"]
    assert all(set(h) == {"path", "title", "description", "score", "why", "snippet"}
               for h in semantic["hits"])
    fused = search_payload(state, "aurinko", mode="auto")
    assert fused["used_modes"] == ["keyword", "semantic"]
    assert fused["degraded_from"] is None


def test_read_resolution_ladder(kotiaurinko):
    state = make_state(kotiaurinko)
    assert read_payload(state, "kuu.md")["path"] == "kuu.md"
    assert read_payload(state, "kuu")["path"] == "kuu.md"            # stem
    assert read_payload(state, "komeeta")["path"] == "komeetta.md"   # fuzzy title
    missing = read_payload(state, "olematon-zzz")
    assert "error" in missing
    assert missing["suggestions"]


def test_read_disambiguation(kotiaurinko):
    for rel, title in (("koru/helmi.md", "Helmi koru"), ("meri/helmi.md", "Helmi meri")):
        target = kotiaurinko / rel
        target.parent.mkdir(exist_ok=True)
        target.write_text(
            f"---\ntype: Concept\ntitle: {title}\ndescription: A pearl.\n---\n\n"
            f"# {title}\n\nSee [Kuu](/kuu.md).\n",
            encoding="utf-8",
        )
    state = make_state(kotiaurinko)
    result = read_payload(state, "helmi")
    assert {c["path"] for c in result["disambiguation"]} == {"koru/helmi.md", "meri/helmi.md"}
    assert result["hint"]


def test_read_full_doc_shape(kotiaurinko):
    result = read_payload(make_state(kotiaurinko), "planeetat.md")
    assert result["truncated"] is False
    assert "Every world orbits" in result["content"]
    assert result["outline"] == ["# Planeetat"]
    assert result["frontmatter"]["type"] == "Concept"
    assert result["frontmatter"]["timestamp"] == "2026-06-01T00:00:00Z"
    assert {n["path"] for n in result["neighbors"]["out"]} == {"aurinko.md", "maa.md"}
    assert {n["path"] for n in result["neighbors"]["in"]} == {"aurinko.md", "index.md", "maa.md"}


def test_read_sections_and_budget(kotiaurinko):
    (kotiaurinko / "osiot.md").write_text(
        "---\ntype: Concept\ntitle: Osiot\ndescription: A sectioned doc.\n---\n\n"
        "# Osiot\n\nIntro, see [Kuu](kuu.md).\n\n"
        "## Alpha\n\n" + ("Alpha text. " * 120) + "\n\n"
        "## Beta\n\nBeta text.\n",
        encoding="utf-8",
    )
    state = make_state(kotiaurinko)
    full = read_payload(state, "osiot.md")
    assert full["outline"] == ["# Osiot", "## Alpha", "## Beta"]
    only_beta = read_payload(state, "osiot.md", sections=["Beta"])
    assert "Beta text." in only_beta["content"]
    assert "Alpha text." not in only_beta["content"]
    slim = read_payload(state, "osiot.md", budget_tokens=60)
    assert slim["truncated"] is True
    assert len(slim["content"]) < len(full["content"])
    assert "sections" in slim["hint"]


def test_neighbors_depth_and_degrade(kotiaurinko):
    # graph = "off": no T3 export exists, so layer=entities degrades to links —
    # the algorithmic default would otherwise serve a real (derived) entity layer.
    (kotiaurinko / "brainpick.toml").write_text('[modules]\ngraph = "off"\n', encoding="utf-8")
    state = make_state(kotiaurinko)
    one = neighbors_payload(state, "maa.md")
    assert one["center"] == "maa.md"
    assert {n["path"] for n in one["nodes"]} == {"maa.md", "kuu.md", "planeetat.md", "index.md"}
    (center,) = [n for n in one["nodes"] if n["path"] == "maa.md"]
    assert center["distance"] == 0
    two = neighbors_payload(state, "maa.md", depth=2)
    assert {n["path"] for n in two["nodes"]} >= {"aurinko.md", "saaret/atolli.md"}
    clamped = neighbors_payload(state, "maa.md", depth=9)  # forgiving: clamps to 3
    depth3 = neighbors_payload(state, "maa.md", depth=3)
    assert {n["path"] for n in clamped["nodes"]} == {n["path"] for n in depth3["nodes"]}
    degraded = neighbors_payload(state, "maa.md", layer="entities")
    assert degraded["degraded_from"] == "entities"
    assert degraded["edges"]
    assert all(set(e) == {"source", "target", "kind"} for e in degraded["edges"])


def _state_with_t3(kotiaurinko):
    state = make_state(kotiaurinko)
    stage_t3_export(kotiaurinko)
    state.reload_artifacts()
    return state


def test_neighbors_entities_layer_over_staged_export(kotiaurinko):
    state = _state_with_t3(kotiaurinko)
    result = neighbors_payload(state, "kuu", layer="entities")  # forgiving stem resolution
    assert result["center"] == "kuu.md"
    assert result["degraded_from"] is None
    assert {n["id"] for n in result["nodes"]} == {"kuu", "maa", "vuorovesi", "planeetat"}
    kuu = next(n for n in result["nodes"] if n["id"] == "kuu")
    assert set(kuu) == {"id", "name", "description", "distance", "source_docs"}
    assert kuu["distance"] == 0
    grounding = {doc for node in result["nodes"] for doc in node["source_docs"]}
    assert grounding == {"aurinko.md", "kuu.md", "maa.md", "planeetat.md"}
    assert {"src": "kuu", "dst": "vuorovesi"} in result["edges"]


def test_neighbors_both_layer_overlays_tagged(kotiaurinko):
    state = _state_with_t3(kotiaurinko)
    result = neighbors_payload(state, "kuu.md", layer="both")
    assert result["degraded_from"] is None
    assert {n["layer"] for n in result["nodes"]} == {"links", "entities"}
    # link nodes carry a doc path, entity nodes an id — overlaid, not merged
    assert any(n["layer"] == "links" and "path" in n for n in result["nodes"])
    assert any(n["layer"] == "entities" and "id" in n for n in result["nodes"])


def test_search_graph_mode_over_staged_export(kotiaurinko):
    state = _state_with_t3(kotiaurinko)
    result = search_payload(state, "what orbits the star", mode="graph", limit=4)
    assert {h["path"] for h in result["hits"]} == {
        "aurinko.md", "komeetta.md", "maa.md", "planeetat.md",
    }
    assert result["used_modes"] == ["graph"]
    assert result["degraded_from"] is None
    assert all("entity graph" in h["why"] for h in result["hits"])


def test_write_rejects_traversal(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "../ulos.md", "# Ulos\n")
    assert result["ok"] is False
    assert "bundle" in result["instruction"]
    assert not (kotiaurinko.parent / "ulos.md").exists()


def test_write_rejects_non_kebab(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "Kuun Vaiheet.md", "# Kuun vaiheet\n")
    assert result["ok"] is False
    assert "kuun-vaiheet.md" in result["instruction"]
    assert not (kotiaurinko / "Kuun Vaiheet.md").exists()


def test_write_refuses_clobber_on_create(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "kuu.md", "# Kaappaus\n")
    assert result["ok"] is False
    assert "replace" in result["instruction"]
    assert "tides" in (kotiaurinko / "kuu.md").read_text(encoding="utf-8")


def test_write_happy_path_bumps_seq_and_timestamp(kotiaurinko):
    state = make_state(kotiaurinko)
    queue = state.subscribe()
    result = write_payload(state, "uusi-kivi", NEW_DOC)
    assert result["ok"] is True
    assert result["path"] == "uusi-kivi.md"
    assert result["seq"] == 2
    assert state.seq == 2
    text = (kotiaurinko / "uusi-kivi.md").read_text(encoding="utf-8")
    assert re.search(r"^timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", text, re.MULTILINE)
    assert "graph.delta" in [name for name, _, _ in drain(queue)]  # went out the shared path
    assert "- [Uusi kivi](uusi-kivi.md)" in (kotiaurinko / "index.md").read_text(encoding="utf-8")


def test_write_leaves_frontmatter_free_docs_without_a_timestamp_block(kotiaurinko):
    """Journals and OKF reserved files carry no frontmatter by contract; a write that
    passed henxels must not grow one on the way out (spec/70 step 4)."""
    state = make_state(kotiaurinko)
    journal = "# 2026-06-01\n\n## 2026-06-01\n\n* **08:00** `kuu` · note — tides logged.\n"
    result = write_payload(state, "paivakirja/2026-06-01", journal)
    assert result["ok"] is True
    assert (kotiaurinko / "paivakirja" / "2026-06-01.md").read_text(encoding="utf-8") == journal


def test_write_append_section(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "kuu.md", "## Nousuvesi\n\nSpring tides.\n", mode="append_section")
    assert result["ok"] is True
    text = (kotiaurinko / "kuu.md").read_text(encoding="utf-8")
    assert "## Nousuvesi" in text
    assert "The moon pulls" in text  # the original body survives


def test_write_add_entry_slots_into_the_newest_first_day(kotiaurinko, monkeypatch):
    """mode add_entry (spec/70): one entry in, the server places it by time — a missing
    day is created with its head, a later entry goes first, an earlier one after, and
    the caller never echoes the day back."""
    set_clock(monkeypatch, "09:00", "07:30", "11:15")
    state = make_state(kotiaurinko)
    day = kotiaurinko / "paivakirja" / "2026-06-02.md"
    first = "* **09:00** `kuu` · note — first.\n  more.\n"
    assert write_payload(state, "paivakirja/2026-06-02", first, mode="add_entry")["ok"] is True
    assert day.read_text(encoding="utf-8") == "# 2026-06-02\n\n## 2026-06-02\n\n" + first
    assert write_payload(state, "paivakirja/2026-06-02", "* **07:30** `kuu` · note — earlier.", mode="add_entry")["ok"] is True
    assert write_payload(state, "paivakirja/2026-06-02", "* **11:15** `kuu` · note — later.", mode="add_entry")["ok"] is True
    assert day.read_text(encoding="utf-8") == (
        "# 2026-06-02\n\n## 2026-06-02\n\n"
        "* **11:15** `kuu` · note — later.\n\n"
        "* **09:00** `kuu` · note — first.\n  more.\n\n"
        "* **07:30** `kuu` · note — earlier.\n"
    )
    bad = write_payload(state, "paivakirja/2026-06-02", "## Not an entry\n", mode="add_entry")
    assert bad["ok"] is False and "HH:MM" in bad["instruction"]
    page = write_payload(state, "muistio", "* **10:00** `kuu` · note — x", mode="add_entry")
    assert page["ok"] is False and "YYYY-MM-DD" in page["instruction"]
    assert not (kotiaurinko / "muistio.md").exists()


def test_concurrent_add_entry_loses_nothing(kotiaurinko, monkeypatch):
    """Fifty threads add one entry each to the same day at once (spec/70: writes are
    serialized server-side) — every entry lands, in time order, none overwritten."""
    from concurrent.futures import ThreadPoolExecutor

    set_clock(monkeypatch, *(f"10:{i:02d}" for i in range(50)))
    state = make_state(kotiaurinko)
    def add(i: int):
        return write_payload(state, "paivakirja/2026-06-03", f"* `kuu` · note — entry {i}.", mode="add_entry")
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(add, range(50)))
    assert all(r["ok"] for r in results), [r for r in results if not r["ok"]][:3]
    text = (kotiaurinko / "paivakirja" / "2026-06-03.md").read_text(encoding="utf-8")
    times = [line[4:9] for line in text.splitlines() if line.startswith("* **")]
    assert times == [f"10:{i:02d}" for i in reversed(range(50))]
    assert all(text.count(f"entry {i}.") == 1 for i in range(50))


def test_add_entry_head_is_the_server_clock(kotiaurinko, monkeypatch):
    """spec/70 server-owned clocks: a model does not know the wall clock, so the entry
    head is the server's — an invented **HH:MM** is replaced, a missing one inserted."""
    set_clock(monkeypatch, "07:33", "08:07")
    state = make_state(kotiaurinko)
    day = kotiaurinko / "paivakirja" / "2026-06-02.md"
    invented = write_payload(state, "paivakirja/2026-06-02", "* **12:00** `kuu` · note — invented time.",
                             mode="add_entry")
    assert invented["ok"] is True
    assert write_payload(state, "paivakirja/2026-06-02", "* `kuu` · note — no time.\n  more.",
                         mode="add_entry")["ok"] is True
    assert day.read_text(encoding="utf-8") == (
        "# 2026-06-02\n\n## 2026-06-02\n\n"
        "* **08:07** `kuu` · note — no time.\n  more.\n\n"
        "* **07:33** `kuu` · note — invented time.\n"
    )


def test_write_stamps_the_timestamp_before_the_referee(kotiaurinko, monkeypatch):
    """spec/70 step 2: henxels judges the stamped doc, so a contract that requires a
    timestamp is met by the server — never by a time the writer had to invent."""
    stamp = set_clock(monkeypatch, "10:00")
    seen = {}

    def referee(state, rel):
        seen[rel] = (state.root / rel).read_text(encoding="utf-8")
        return None, None

    monkeypatch.setattr(mcp_server, "_run_henxels", referee)
    state = make_state(kotiaurinko)
    assert write_payload(state, "uusi-kivi", NEW_DOC)["ok"] is True
    assert write_payload(state, "kuu.md", KUU_REWRITE, mode="replace")["ok"] is True
    for rel in ("uusi-kivi.md", "kuu.md"):
        assert f"\ntimestamp: {stamp}\n" in seen[rel]
        assert (kotiaurinko / rel).read_text(encoding="utf-8") == seen[rel]
    assert "08:30:00Z" not in seen["kuu.md"]  # the writer's own timestamp is overwritten


# -- brain_write meta (spec/70): the frontmatter as data -----------------------------


def test_write_meta_is_serialized_by_the_server(kotiaurinko, monkeypatch):
    stamp = set_clock(monkeypatch, "10:00")
    state = make_state(kotiaurinko)
    result = write_payload(state, "uusi-kivi", "\n# Uusi kivi\n\nNear [Kuu](kuu.md).\n", meta={
        "type": "Concept", "title": "Uusi kivi", "description": "A new rock: hard, #1.",
        "tags": ["kivi", "a b: c"], "timestamp": "2026-09-11T12:00:00Z", "aliases": [],
        "lang": "yes", "note": "Äänitys ", "year": "2026",
    })
    assert result["ok"] is True
    assert (kotiaurinko / "uusi-kivi.md").read_text(encoding="utf-8") == (
        "---\ntype: Concept\ntitle: Uusi kivi\n"
        'description: "A new rock: hard, #1."\ntags: [kivi, "a b: c"]\naliases: []\n'
        'lang: "yes"\nnote: "Äänitys "\nyear: "2026"\n'
        f"timestamp: {stamp}\n---\n\n# Uusi kivi\n\nNear [Kuu](kuu.md).\n"
    )


def test_write_body_only_replace_keeps_the_frontmatter(kotiaurinko, monkeypatch):
    stamp = set_clock(monkeypatch, "10:00")
    state = make_state(kotiaurinko)
    assert write_payload(state, "kuu.md", "# Kuu\n\nPlain.\n", mode="replace")["ok"] is True
    assert (kotiaurinko / "kuu.md").read_text(encoding="utf-8") == (
        f"---\ntype: Concept\ntags: [kuu]\ntimestamp: {stamp}\n---\n\n# Kuu\n\nPlain.\n"
    )
    merged = write_payload(state, "kuu.md", "# Kuu\n\nRewritten.\n", mode="replace",
                           meta={"title": "Kuu", "tags": None})
    assert merged["ok"] is True
    assert (kotiaurinko / "kuu.md").read_text(encoding="utf-8") == (
        f"---\ntype: Concept\ntimestamp: {stamp}\ntitle: Kuu\n---\n\n# Kuu\n\nRewritten.\n"
    )


def test_write_meta_rewrites_whole_key_spans_in_place(kotiaurinko, monkeypatch):
    stamp = set_clock(monkeypatch, "10:00")
    state = make_state(kotiaurinko)
    doc = "---\ntype: Concept\ntags:\n  - a\n  - b\ndescription: >\n  folded\n  text\ntitle: Old\n---\nbody\n"
    result = write_payload(state, "spans", doc, meta={"tags": ["c"], "description": None, "title": "New"})
    assert result["ok"] is True
    assert (kotiaurinko / "spans.md").read_text(encoding="utf-8") == (
        f"---\ntype: Concept\ntags: [c]\ntitle: New\ntimestamp: {stamp}\n---\nbody\n"
    )


def test_write_append_section_merges_meta_into_the_previous_block(kotiaurinko, monkeypatch):
    stamp = set_clock(monkeypatch, "10:00")
    state = make_state(kotiaurinko)
    result = write_payload(state, "kuu.md", "## Nousuvesi\n\nSpring tides.\n", mode="append_section",
                           meta={"description": "The moon."})
    assert result["ok"] is True
    text = (kotiaurinko / "kuu.md").read_text(encoding="utf-8")
    assert text.startswith(f"---\ntype: Concept\ntags: [kuu]\ntimestamp: {stamp}\ndescription: The moon.\n---\n\n# Kuu\n")
    assert text.endswith("```\n\n## Nousuvesi\n\nSpring tides.\n")


def test_write_meta_rejects_what_it_cannot_serialize(kotiaurinko):
    state = make_state(kotiaurinko)
    for meta in ({"bad key": "x"}, {"n": 3}, {"tags": ["a", 1]}, {"nested": {"a": "b"}}):
        result = write_payload(state, "uusi", "# X\n", meta=meta)
        assert result["ok"] is False and "meta" in result["instruction"], meta
    assert not (kotiaurinko / "uusi.md").exists()
    entry = write_payload(state, "paivakirja/2026-06-04", "* `kuu` · note — x", mode="add_entry",
                          meta={"title": "X"})
    assert entry["ok"] is False and "frontmatter-free" in entry["instruction"]
    assert not (kotiaurinko / "paivakirja" / "2026-06-04.md").exists()


def test_write_gate_refusal(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "uusi.md", "# X\n", refusal='writes are off — set [serve] writes = "guarded"')
    assert result["ok"] is False
    assert "guarded" in result["instruction"]
    assert not (kotiaurinko / "uusi.md").exists()


def test_write_henxels_violation_restores(kotiaurinko, monkeypatch, tmp_path):
    (kotiaurinko / "henxels.yaml").write_text("henxels: []\n", encoding="utf-8")
    bin_dir = stage_fake_henxels(tmp_path / "bin", "kebab-case or bust")
    monkeypatch.setenv("PATH", prepend_path(os.environ["PATH"], bin_dir))
    state = make_state(kotiaurinko)

    created = write_payload(state, "uusi.md", "# X\n")
    assert created["ok"] is False
    assert created["instruction"].strip() == "kebab-case or bust"
    assert not (kotiaurinko / "uusi.md").exists()          # created file rolled back

    replaced = write_payload(state, "kuu.md", "# Kuu\n\nClobbered.\n", mode="replace")
    assert replaced["ok"] is False
    assert "tides" in (kotiaurinko / "kuu.md").read_text(encoding="utf-8")  # bytes restored
    assert state.seq == 1


def test_write_honours_a_contract_above_the_bundle(kotiaurinko, monkeypatch, tmp_path):
    """spec/80 layout: henxels.yaml at the repo root, the bundle below it. `auto` must
    still run the contract — henxels resolves it by walking up, and so must we."""
    (kotiaurinko.parent / "henxels.yaml").write_text("henxels: []\n", encoding="utf-8")
    bin_dir = stage_fake_henxels(tmp_path / "bin", "kebab-case or bust")
    monkeypatch.setenv("PATH", prepend_path(os.environ["PATH"], bin_dir))
    state = make_state(kotiaurinko)
    assert state.config.validate.henxels == "auto"

    created = write_payload(state, "uusi.md", "# X\n")
    assert created["ok"] is False
    assert created["instruction"].strip() == "kebab-case or bust"
    assert not (kotiaurinko / "uusi.md").exists()


# -- brain_write optimistic concurrency (spec/70 base_sha) --------------------------


def test_write_stale_base_sha_conflicts_without_writing(kotiaurinko):
    state = make_state(kotiaurinko)
    before = (kotiaurinko / "kuu.md").read_text(encoding="utf-8")
    result = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha="0" * 64)
    assert result["ok"] is False
    assert result["conflict"] is True
    assert result["current_sha"] == sha256_hex(before.encode("utf-8"))
    assert result["theirs"] == before
    assert "re-read" in result["instruction"]
    assert "merged" not in result  # no git base, no model → the manual path
    assert (kotiaurinko / "kuu.md").read_text(encoding="utf-8") == before  # MUST NOT write
    assert state.seq == 1


def test_write_matching_base_sha_writes_normally(kotiaurinko):
    state = make_state(kotiaurinko)
    sha = sha256_hex((kotiaurinko / "kuu.md").read_bytes())
    result = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha=sha)
    assert result["ok"] is True
    assert result["seq"] == 2
    assert "rewritten" in (kotiaurinko / "kuu.md").read_text(encoding="utf-8")


def test_write_conflict_retry_with_current_sha_succeeds_and_bumps_seq(kotiaurinko):
    state = make_state(kotiaurinko)
    conflict = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha="0" * 64)
    assert conflict["conflict"] is True
    assert state.seq == 1
    retry = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace",
                          base_sha=conflict["current_sha"])
    assert retry["ok"] is True
    assert retry["seq"] == 2
    assert state.seq == 2


def test_write_omitted_base_sha_keeps_last_write_wins(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace")
    assert result["ok"] is True  # today's behavior, untouched


def test_write_base_sha_on_a_deleted_doc_conflicts(kotiaurinko):
    state = make_state(kotiaurinko)
    result = write_payload(state, "poistettu.md", "# X\n", mode="replace", base_sha="a" * 64)
    assert result["ok"] is False
    assert result["conflict"] is True
    assert result["current_sha"] is None
    assert result["theirs"] == ""
    assert not (kotiaurinko / "poistettu.md").exists()


def test_write_conflict_merged_proposal_from_the_configured_model(kotiaurinko):
    (kotiaurinko / "brainpick.local.toml").write_text(
        '[models.extraction]\nkind = "mock"\n', encoding="utf-8",
    )
    state = make_state(kotiaurinko)
    result = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha="0" * 64)
    assert result["conflict"] is True
    assert result["merged"]["strategy"] == "llm"  # no git base → the two-input model merge
    assert result["merged"]["content"] == KUU_REWRITE  # MockChat echoes the YOURS section
    assert "proposal" in result["hint"]
    assert "rewritten" not in (kotiaurinko / "kuu.md").read_text(encoding="utf-8")  # never applied


def test_write_conflict_insane_model_output_omits_merged(kotiaurinko, monkeypatch):
    monkeypatch.setattr("brainpick.mcp_server.make_chat",
                        lambda *_a, **_k: MockChat(reply="<<<<<<< broken\n"))
    state = make_state(kotiaurinko)
    result = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha="0" * 64)
    assert result["conflict"] is True
    assert "merged" not in result  # the sanity gate held — manual path


def test_write_conflict_three_way_from_a_git_base(kotiaurinko):
    def git(*args):
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
             "-c", "core.autocrlf=false",  # deterministic blobs on Windows runners
             *args],
            cwd=kotiaurinko, check=True, capture_output=True,
        )

    git("init", "-q")
    git("add", "-A")
    git("commit", "-qm", "base")
    base_bytes = (kotiaurinko / "kuu.md").read_bytes()
    base_text = base_bytes.decode("utf-8")

    # A foreign writer edits the tides line after our writer read the doc.
    theirs = base_text.replace(
        "The moon pulls the tides of [Maa](maa.md).",
        "The moon pulls the spring tides of [Maa](maa.md).",
    )
    # newline="\n": Windows text-mode would rewrite every \n as CRLF, making
    # EVERY line differ from the LF git base — the three-way then sees total
    # overlap and rightly declines. (Real CRLF forks degrade to llm/manual by
    # design; this test exercises the clean-fork path.)
    (kotiaurinko / "kuu.md").write_text(theirs, encoding="utf-8", newline="\n")

    state = make_state(kotiaurinko)
    yours = base_text + "\n## Vaiheet\n\nNew moon, then full moon.\n"
    result = write_payload(state, "kuu.md", yours, mode="replace",
                           base_sha=sha256_hex(base_bytes))
    assert result["conflict"] is True
    assert result["merged"]["strategy"] == "three-way"  # git HEAD supplied the verified base
    assert "spring tides" in result["merged"]["content"]  # their edit survives
    assert "## Vaiheet" in result["merged"]["content"]    # your edit survives
    assert "## Vaiheet" not in (kotiaurinko / "kuu.md").read_text(encoding="utf-8")  # proposal only


def test_write_conflict_budget_shapes_theirs(kotiaurinko):
    state = make_state(kotiaurinko)
    full = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha="0" * 64)
    slim = write_payload(state, "kuu.md", KUU_REWRITE, mode="replace", base_sha="0" * 64,
                         budget_tokens=40)
    assert slim["truncated"] is True
    assert len(slim["theirs"]) < len(full["theirs"])
    assert slim["theirs"].endswith("…")
    assert slim["current_sha"] == full["current_sha"]  # the retry key is never trimmed


def test_write_henxels_missing_warns(kotiaurinko, monkeypatch, tmp_path):
    (kotiaurinko / "henxels.yaml").write_text("henxels: []\n", encoding="utf-8")
    empty = tmp_path / "emptybin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    state = make_state(kotiaurinko)
    result = write_payload(state, "uusi-kivi.md", NEW_DOC)
    assert result["ok"] is True
    assert "warning" in result
    assert (kotiaurinko / "uusi-kivi.md").is_file()


# -- brain_show (spec/95): the 6th tool — ephemeral presentations, not write-gated --


def test_show_payload_reports_shown_dropped_seq_and_hint(kotiaurinko):
    from brainpick.mcp_server import show_payload

    state = make_state(kotiaurinko)
    queue = state.subscribe()
    result = show_payload(state, nodes=["aurinko.md", "ei-ole"], annotation="hi")
    assert result["ok"] is True
    assert result["shown"] == 1
    assert result["dropped"] == ["ei-ole"]
    assert result["seq"] == 1
    # the exact hint — pinned so the Node twin stays byte-identical (cross-engine parity)
    assert result["hint"] == (
        "showing 1 node(s) live in every open UI — "
        "call brain_show again to change it, or with clear:true to dismiss. (dropped 1: ei-ole)"
    )
    # it broadcasts (the open UIs light up), and never writes / compiles
    assert [name for name, _, _ in drain(queue)] == ["brain.show"]
    assert state.seq == 1


def test_show_payload_clear_has_a_dedicated_hint(kotiaurinko):
    from brainpick.mcp_server import show_payload

    state = make_state(kotiaurinko)
    result = show_payload(state, clear=True)
    assert result == {
        "ok": True, "shown": 0, "dropped": [], "seq": 1,
        "hint": "cleared — every open UI dropped its spotlight and caption.",
    }


def test_brain_show_registered_as_sixth_tool_even_when_writes_refused(kotiaurinko):
    import asyncio

    from brainpick.mcp_server import create_mcp_server

    state = make_state(kotiaurinko)
    # write_refusal is set, yet brain_show is present — a presentation is not a write
    server = create_mcp_server(state, write_refusal="writes off")
    tools = asyncio.run(server.list_tools())
    assert {t.name for t in tools} == {
        "brain_overview", "brain_search", "brain_read",
        "brain_neighbors", "brain_write", "brain_show",
    }


# -- journal entries as read units (spec/70) ------------------------------------------

_DAY = ("# 2026-09-09\n\n## 2026-09-09\n\n"
        "* **05:50** `pipeless` · debug — proof audits passed on version/229\n  audit details\n\n"
        "* **05:30** `nuutti-brain` · feature — every harness wired\n  wiring details\n  more wiring\n\n"
        "* **05:05** `pipeless` · debug — listing fallback stops early\n  listing details\n")


def test_outline_lists_journal_entries_and_sections_take_a_time():
    from brainpick.mcp_server import _extract_sections, _outline

    outline = _outline(_DAY)
    assert outline[:2] == ["# 2026-09-09", "## 2026-09-09"]
    assert outline[2].startswith("* **05:50**") and len(outline) == 5
    one = _extract_sections(_DAY, ["05:30"])
    assert one == "* **05:30** `nuutti-brain` · feature — every harness wired\n  wiring details\n  more wiring\n"
    two = _extract_sections(_DAY, ["05:50", "05:05"])
    assert two.count("* **") == 2 and "05:30" not in two
    assert _extract_sections(_DAY, ["## 2026-09-09"]).count("* **") == 3  # a heading still takes its whole section


def test_query_log_writes_one_raw_line_per_search(tmp_path, monkeypatch):
    import json

    from brainpick.querylog import log_query, new_session_id

    monkeypatch.setenv("BRAINPICK_QUERY_LOG_DIR", str(tmp_path))
    sid = new_session_id()
    request = {"situation": "the deploy failed on a sidecar race", "terms": ["FUSE"], "mode": "auto",
               "limit": 10, "scope": None}
    result = {"hits": [{"path": "journals/2026-09-09.md"}], "used_modes": ["keyword", "semantic"],
              "degraded_from": None}
    path = log_query(sid, "nuutti-brain", request, result)
    log_query(sid, "nuutti-brain", request, result)
    assert path == tmp_path / f"{sid}.jsonl"
    lines = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(lines) == 2
    assert lines[0]["situation"] == request["situation"] and lines[0]["terms"] == ["FUSE"]
    assert lines[0]["hits"] == ["journals/2026-09-09.md"] and lines[0]["used_modes"] == ["keyword", "semantic"]
    monkeypatch.setenv("BRAINPICK_QUERY_LOG", "0")
    assert log_query(sid, "nuutti-brain", request, result) is None
