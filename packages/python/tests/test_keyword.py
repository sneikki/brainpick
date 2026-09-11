from brainpick.compile.t1 import build_docs_records
from brainpick.core.bundle import scan
from brainpick.query.keyword import search


def test_keyword_search_set(kotiaurinko):
    records = build_docs_records(scan(kotiaurinko))
    hits = search(records, "aurinko", limit=8)
    assert {h["path"] for h in hits} == {
        "aurinko.md", "komeetta.md", "planeetat.md", "yksinainen.md",
    }
    # the doc titled Aurinko outranks passing mentions
    assert hits[0]["path"] == "aurinko.md"
    # reserved docs never surface (index.md links everything)
    assert all(not h["path"].endswith("index.md") for h in hits)


def test_search_result_shape(kotiaurinko):
    records = build_docs_records(scan(kotiaurinko))
    (hit,) = [h for h in search(records, "tides", limit=3) if h["path"] == "kuu.md"]
    assert set(hit) == {"description", "path", "score", "snippet", "source", "title"}
    assert hit["source"] == "keyword"
    assert "tides" in hit["snippet"]


def test_no_hits(kotiaurinko):
    records = build_docs_records(scan(kotiaurinko))
    assert search(records, "zzzzz kuulumaton", limit=5) == []


def test_tokenizer_parity_vector():
    """Shared unit vector with the Node engine: underscore is a boundary, hyphen splits,
    digits kept — and a run joined by single '-'/'_' is ALSO emitted whole, after its
    parts, so an identifier is matched as itself."""
    from brainpick.query.keyword import tokenize

    assert tokenize("Aurinko-itse_kuu 123 tähti") == ["aurinko", "itse", "kuu", "123", "tähti", "aurinko-itse_kuu"]
    assert tokenize("SAI-PIPELESS-V and identity_authorized_bc_id") == [
        "sai", "pipeless", "v", "and", "identity", "authorized", "bc", "id",
        "sai-pipeless-v", "identity_authorized_bc_id",
    ]
    assert tokenize("__init__") == ["init"]  # doubled separators are boundaries, not joins
    assert tokenize("...") == []


def test_numeric_fragments_of_a_compound_are_not_query_terms():
    """A date-prefixed file name in the query must not match every day of that month on its
    date parts (spec/50): the compound still matches whole, a bare number still matches."""
    from brainpick.query.keyword import query_tokens, search

    assert query_tokens("2026-09-09-soniox-spec.md") == [
        "soniox", "spec", "md", "2026-09-09-soniox-spec",
    ]
    assert query_tokens("SHAI-127 and error 40002") == ["shai", "error", "40002", "shai-127"]
    records = [
        {"path": "j/2026-09-09.md", "title": "2026-09-09", "description": None, "text": "* soniox spec written", "reserved": False},
        {"path": "j/2026-09-02.md", "title": "2026-09-02", "description": None, "text": "* deepgram dropped", "reserved": False},
    ]
    assert [h["path"] for h in search(records, "2026-09-09-soniox-spec.md")] == ["j/2026-09-09.md"]
    assert [h["path"] for h in search(records, "40002")] == []


def test_stopwords_drop_from_the_query_only():
    """A sentence query no longer matches every doc on its function words (spec/50),
    and a query made only of stopwords finds nothing — the docs themselves are indexed whole."""
    from brainpick.query.keyword import STOPWORDS, query_tokens, search

    assert query_tokens("the deploy failed and the tool refused") == ["deploy", "failed", "tool", "refused"]
    assert "the" in STOPWORDS and "deploy" not in STOPWORDS
    records = [
        {"path": "a.md", "title": "A", "description": None, "text": "the moon and the sun", "reserved": False},
        {"path": "b.md", "title": "B", "description": None, "text": "deploy failed", "reserved": False},
    ]
    assert search(records, "the and") == []
    assert [h["path"] for h in search(records, "why the deploy failed")] == ["b.md"]


def test_keyword_snippet_opens_at_the_entry_head():
    """A log-shaped doc shows the matched entry from its `* ` head, not a window around
    the word — so a journal hit names the entry (spec/50)."""
    from brainpick.query.keyword import search

    text = ("# 2026-09-09\n\n## 2026-09-09\n\n"
            "* **05:50** `pipeless` · debug — proof audits passed\n  details about audits\n\n"
            "* **03:40** `pipeless` · progress — deploy failed on a FUSE mount race\n  more lines\n")
    records = [{"path": "d.md", "title": "2026-09-09", "description": None, "text": text, "reserved": False}]
    hit = search(records, "FUSE mount")[0]
    assert hit["snippet"].startswith("* **03:40**")


def test_keyword_snippet_picks_the_entry_that_matches_best():
    """Two entries mention FUSE; the one ABOUT the deploy race (more query terms) wins the
    snippet, even though the other comes first in the file (spec/50)."""
    from brainpick.query.keyword import search

    text = ("# 2026-09-09\n\n## 2026-09-09\n\n"
            "* **07:45** `brainpick` · decision — example call quoting \"FUSE mount failed\"\n  unrelated\n\n"
            "* **03:40** `pipeless` · progress — deploy failed on a sidecar FUSE mount race at startup\n  rerun made no revision\n")
    records = [{"path": "d.md", "title": "2026-09-09", "description": None, "text": text, "reserved": False}]
    hit = search(records, "FUSE mount race sidecar")[0]
    assert hit["snippet"].startswith("* **03:40**")


def test_journal_entries_are_ranked_as_units():
    """A day with many entries is not one long doc: the entry that matches ranks the day
    above a short page mentioning the words once, and the snippet is that entry's."""
    from brainpick.query.keyword import search

    filler = "\n".join(f"* **{h:02d}:00** `x` · note — unrelated chatter about other things\n  more chatter" for h in range(1, 40))
    day = filler + "\n* **23:30** `pipeless` · debug — FUSE mount race on the sidecar at startup\n  details\n"
    records = [
        {"path": "journals/day.md", "title": "2026-09-09", "description": None, "text": day, "reserved": False},
        {"path": "knowledge/page.md", "title": "Page", "description": None,
         "text": "a page that mentions the sidecar once in passing", "reserved": False},
    ]
    hits = search(records, "FUSE mount race sidecar")
    assert [h["path"] for h in hits] == ["journals/day.md", "knowledge/page.md"]
    assert hits[0]["snippet"].startswith("* **23:30**")
