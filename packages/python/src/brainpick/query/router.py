"""One search surface, four strategies (spec/30 + spec/50): keyword always,
semantic when T2 is fresh, RRF fusion under auto, honest degradation markers."""
from __future__ import annotations

from typing import Callable

from brainpick.query.keyword import search as keyword_search
from brainpick.query.keyword import title_search

KNOWN_MODES = ("auto", "keyword", "semantic", "graph")
RRF_K = 60  # spec/30: reciprocal rank fusion constant
# The strongest few title matches a mode may inject when its own retrieval missed the
# named page — capped so a common word can't flood the answer with same-topic pages.
TITLE_INJECT_CAP = 3

# auto may consult the entity graph, but only for relation-shaped queries — the
# small deterministic heuristic that keeps "what connects to X" honest without
# dragging graph noise into every keyword lookup (spec/40).
RELATIONAL_HINTS = ("relate", "connect", "between")

SemanticFn = Callable[[str, int], list[dict]]
GraphFn = Callable[[str, int], list[dict]]


def is_relational(query: str) -> bool:
    """A query auto should widen with graph results: it asks about connections
    ('relate'/'related', 'connect'/'connects', 'between'). Substring match so the
    stems catch their inflections; deterministic and conservative."""
    lowered = str(query or "").lower()
    return any(hint in lowered for hint in RELATIONAL_HINTS)


def resolve_mode(mode) -> str:
    """Unknown modes fall back to auto — never an error (spec/50)."""
    mode = str(mode or "auto")
    return mode if mode in KNOWN_MODES else "auto"


def rrf_fuse(rankings: dict[str, list[dict]], limit: int) -> list[dict]:
    """RRF (k=60) across retrievers, deduped by document. A hit keeps the fields
    of the retriever contributing its best rank — that retriever is its source."""
    scores: dict[str, float] = {}
    best: dict[str, tuple[int, dict]] = {}  # path -> (best rank, that retriever's hit)
    for hits in rankings.values():
        for rank, hit in enumerate(hits, start=1):
            path = hit["path"]
            scores[path] = scores.get(path, 0.0) + 1.0 / (RRF_K + rank)
            if path not in best or rank < best[path][0]:
                best[path] = (rank, hit)

    fused = []
    for path in sorted(scores, key=lambda p: (-scores[p], p)):
        hit = dict(best[path][1])
        hit["score"] = round(scores[path], 6)
        fused.append(hit)
    return fused[:limit]


def ensure_titles(hits: list[dict], title_hits: list[dict], limit: int) -> list[dict]:
    """Guarantee the strongest TITLE matches are present: inject any the mode's own
    retrieval missed at the FRONT (you typed a page's name — that page should appear),
    capped so a common word can't flood the answer. A NO-OP when nothing is missing, so
    a result the retriever already found is returned byte-for-byte unchanged."""
    if not title_hits:
        return hits[:limit]
    present = {h["path"] for h in hits}
    missing = [h for h in title_hits if h["path"] not in present][:TITLE_INJECT_CAP]
    if not missing:
        return hits[:limit]
    return (missing + hits)[:limit]


def split_query(query: str | None, terms: list[str] | None, situation: str | None) -> tuple[str, str, str]:
    """(keyword query, semantic query, title query) — spec/50 two-input search.

    `situation` (the episode in sentences) is the only text the semantic engine sees:
    an identifier list embeds to nothing useful. The keyword engine sees `terms`
    (identifiers, verbatim) AND the situation — a sentence costs BM25 only some
    function-word noise, and its nouns still match. A bare `query` feeds both, the
    legacy single-string shape. The title query is everything."""
    if terms is None and situation is None:
        q = str(query or "")
        return q, q, q
    ids = " ".join(str(t) for t in (terms or []) if str(t).strip()).strip()
    sem = str(situation or "").strip()
    both = " ".join(part for part in (ids, sem) if part)
    return both, sem, both


def run_search(
    records: list[dict],
    tiers: dict,
    query: str | None = None,
    mode: str = "auto",
    limit: int = 8,
    semantic_fn: SemanticFn | None = None,
    graph_fn: GraphFn | None = None,
    link_graph: dict | None = None,
    terms: list[str] | None = None,
    situation: str | None = None,
) -> dict:
    """The spec/50 response body: {"hits", "used_modes", "degraded_from"}.

    Two inputs, two engines: `situation` alone goes to the semantic retriever, the
    keyword retriever gets `terms` plus the situation (a legacy `query` goes to both). `semantic_fn(query, limit)` runs
    the vector retriever; `graph_fn(query, limit)` runs the T3 entity-graph retriever
    (present iff the export loaded). Callers wire them to query.vectors.semantic_search
    and kg.graph_search. Any tier's trouble downgrades the answer with a marker, never
    errors the call. Terms without a situation is a keyword search; a situation
    without terms still runs both engines.
    """
    resolved = resolve_mode(mode)
    t2_fresh = tiers.get("t2") == "fresh" and semantic_fn is not None
    t3_on = graph_fn is not None
    kw_query, sem_query, title_query = split_query(query, terms, situation)
    # the keyword engine's fallback text when it has no terms of its own
    kw_or_sem = kw_query or sem_query

    if resolved == "keyword":
        return _body(keyword_search(records, kw_or_sem, limit=limit), ["keyword"], None)
    if resolved == "graph":
        if t3_on:
            return _body(graph_fn(sem_query or kw_query, limit), ["graph"], None)
        # T3 absent: degrade to a T1 link-walk over keyword hits (spec/40)
        from brainpick.kg import link_walk_search

        hits = (link_walk_search(link_graph, records, kw_or_sem, limit) if link_graph
                else keyword_search(records, kw_or_sem, limit=limit))
        return _body(hits, ["keyword"], "graph")

    semantic_hits: list[dict] | None = None
    if t2_fresh and sem_query:
        try:
            semantic_hits = semantic_fn(sem_query, limit)
        except Exception:
            semantic_hits = None  # degrade below; T2 trouble must never error a search

    # A doc the query NAMES by title is surfaced in every retrieval mode — vectors miss
    # short/technical title words, and RRF can bury a strong keyword title hit, so this
    # guarantees the named page never goes missing (only injected when actually absent).
    title_hits = title_search(records, title_query, limit)

    if resolved == "semantic":
        if semantic_hits is None:
            return _body(keyword_search(records, sem_query or kw_query, limit=limit), ["keyword"], "semantic")
        return _body(ensure_titles(semantic_hits, title_hits, limit), ["semantic"], None)

    # auto: fuse whatever is available (spec/30: RRF k=60, dedupe by document).
    # The entity graph joins only for relation-shaped queries (spec/40).
    rankings: dict[str, list[dict]] = {"keyword": keyword_search(records, kw_or_sem, limit=limit)}
    if semantic_hits is not None:
        rankings["semantic"] = semantic_hits
    if t3_on and is_relational(sem_query or kw_query):
        rankings["graph"] = graph_fn(sem_query or kw_query, limit)

    degraded_from = "semantic" if semantic_hits is None and sem_query else None
    if len(rankings) == 1:
        only = next(iter(rankings))
        return _body(ensure_titles(rankings[only], title_hits, limit), [only], degraded_from)
    used_modes = [mode for mode in ("keyword", "semantic", "graph") if mode in rankings]
    return _body(ensure_titles(rrf_fuse(rankings, limit), title_hits, limit), used_modes, degraded_from)


def _body(hits: list[dict], used_modes: list[str], degraded_from: str | None) -> dict:
    return {"hits": hits, "used_modes": used_modes, "degraded_from": degraded_from}
