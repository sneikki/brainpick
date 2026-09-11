"""Keyword retrieval: BM25 over docs.jsonl records (spec/50 — normative for
conformance). Depends on nothing beyond T1, so search works everywhere."""
from __future__ import annotations

import math
import re
from collections import Counter

_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)
# An identifier is also a token of its own: a run of word tokens joined by single '-' or
# '_' (SAI-PIPELESS-V, identity_authorized_bc_id) is emitted whole after its parts, so a
# query naming it matches it as itself, not only the common words it is built from.
_COMPOUND = re.compile(r"[^\W_]+(?:[-_][^\W_]+)+", re.UNICODE)
K1 = 1.2
B = 0.75
SNIPPET_WINDOW = 240
# a column-0 list item opens a log entry (journal days, changelogs)
_ENTRY_HEAD = re.compile(r"^\* ", re.MULTILINE)
# How far back from the first match the snippet looks for the head of the log entry
# ("* " at column 0) that contains it, so a journal hit is shown from its entry, not from
# wherever the word fell.
ENTRY_LOOKBACK = 4000
# Closed-class English function words, dropped from the QUERY only (spec/50): documents are
# indexed whole, so a query that is a sentence stops matching every doc on "the" and "and",
# and its snippet lands on a content word. Not a frequency threshold — a fixed list, the
# same in both engines. The brain is English (its contract enforces it), so one language.
STOPWORDS = frozenset("""
a an the and or but nor of to in on at for with by from as is are was were be been being
it its this that these those there here not no do does did done have has had having i me
my we us our you your he him his she her they them their what which who whom whose when
where why how then than so if into onto over under about after before between while
also just very can could will would shall should may might must
""".split())


def tokenize(text: str) -> list[str]:
    lowered = text.lower()
    return _TOKEN.findall(lowered) + _COMPOUND.findall(lowered)


def query_tokens(query: str) -> list[str]:
    """The query's tokens minus stopwords and minus the numeric fragments of its compound
    identifiers — what the keyword retrievers match on. `2026-09-09-soniox-spec.md` must not
    match every day of that month on `2026` and `09`; the compound itself still matches
    whole, and `SHAI-127` keeps `shai` and `shai-127` (a bare `40002` is not a fragment)."""
    numeric_parts = {
        part for compound in _COMPOUND.findall(query.lower())
        for part in re.split(r"[-_]", compound) if part.isdigit()
    }
    return [t for t in tokenize(query) if t not in STOPWORDS and t not in numeric_parts]


def _searchable(record: dict, unit: str) -> str:
    title, description = record["title"], record["description"] or ""
    return "\n".join([title, title, title, description, description, unit])


def _units(record: dict) -> list[str]:
    """The BM25 units of a record: a log-shaped doc (two or more column-0 `* ` entries)
    is one unit per entry, anything else one unit — so a journal day with sixty entries
    is sixty short documents to the ranker, not one huge one, and the entry ABOUT a
    phrase outranks the entry that merely cites it (spec/50 "Keyword units")."""
    text = record["text"]
    starts = [m.start() for m in _ENTRY_HEAD.finditer(text)]
    if len(starts) < 2:
        return [text]
    return [text[start:(starts[i + 1] if i + 1 < len(starts) else len(text))] for i, start in enumerate(starts)]


def search(records: list[dict], query: str, limit: int = 8) -> list[dict]:
    corpus = [r for r in records if not r["reserved"]]
    if not corpus:
        return []

    units: list[tuple[dict, str]] = [(r, u) for r in corpus for u in _units(r)]
    term_freqs = [Counter(tokenize(_searchable(r, u))) for r, u in units]
    unit_lengths = [sum(tf.values()) for tf in term_freqs]
    avg_length = sum(unit_lengths) / len(unit_lengths) if units else 0.0

    query_terms = query_tokens(query)
    if not query_terms or avg_length == 0:
        return []

    unit_count = len(units)
    unit_freq = {t: sum(1 for tf in term_freqs if tf[t] > 0) for t in set(query_terms)}

    best: dict[str, dict] = {}  # path -> the record's best-scoring unit as a hit
    for (record, unit), tf, ul in zip(units, term_freqs, unit_lengths):
        score = 0.0
        for term in query_terms:
            if tf[term] == 0:
                continue
            idf = math.log((unit_count - unit_freq[term] + 0.5) / (unit_freq[term] + 0.5) + 1)
            score += idf * (tf[term] * (K1 + 1)) / (tf[term] + K1 * (1 - B + B * ul / avg_length))
        if score <= 0:
            continue
        current = best.get(record["path"])
        if current is None or score > current["score"]:
            best[record["path"]] = {
                "description": record["description"],
                "path": record["path"],
                "score": round(score, 6),
                "snippet": _snippet(unit, query_terms),
                "source": "keyword",
                "title": record["title"],
            }

    hits = sorted(best.values(), key=lambda h: (-h["score"], h["path"]))
    return hits[:limit]


def _snippet(text: str, query_terms: list[str]) -> str | None:
    lowered = text.lower()
    first = min((i for i in (lowered.find(t) for t in query_terms) if i != -1), default=-1)
    if first == -1:
        return None
    # a log-shaped doc: open the snippet at the head of the entry the match sits in
    head = text.rfind("\n* ", max(0, first - ENTRY_LOOKBACK), first + 1)
    if head != -1:
        start = head + 1
    elif text.startswith("* ") and first < ENTRY_LOOKBACK:
        start = 0
    else:
        start = max(0, first - 60)
    return " ".join(text[start : start + SNIPPET_WINDOW].split())


def _covers(query_token: str, title_token: str) -> bool:
    """Does a TITLE token account for a query token? Exact, or a short prefix-stem so a
    simple inflection reaches its stem ('agents'→'agent', 'connects'→'connect') without
    stemming machinery — bounded to a ±2 length prefix so it never over-fires (e.g.
    'auth' does NOT swallow 'authentication')."""
    if query_token == title_token:
        return True
    if len(query_token) >= 4 and len(title_token) >= 4 and abs(len(query_token) - len(title_token)) <= 2:
        return query_token.startswith(title_token) or title_token.startswith(query_token)
    return False


def title_search(records: list[dict], query: str, limit: int = 8) -> list[dict]:
    """Docs whose TITLE the query names — a deterministic T1 navigational signal so
    typing an article's name always finds that article (in every mode). A doc qualifies
    only when EVERY query token is covered by some title token (exact or short
    prefix-stem), so 'cli'→'CLI reference' and 'agents'→'Agent integrations' match while
    an unrelated word does not. Ranked exact-title first, then the tightest (fewest
    extra title tokens), then path — deterministic across engines."""
    q_tokens = query_tokens(query)
    if not q_tokens:
        return []
    q_unique = list(dict.fromkeys(q_tokens))
    scored: list[tuple[int, int, dict]] = []
    for record in records:
        if record["reserved"]:
            continue
        t_tokens = tokenize(record["title"])
        if not t_tokens:
            continue
        if not all(any(_covers(q, t) for t in t_tokens) for q in q_unique):
            continue
        exact = 1 if t_tokens == q_tokens else 0
        scored.append((exact, len(t_tokens), record))
    scored.sort(key=lambda s: (-s[0], s[1], s[2]["path"]))
    hits: list[dict] = []
    for exact, _ntok, record in scored[:limit]:
        hits.append({
            "description": record["description"],
            "path": record["path"],
            "score": round(1.0 + exact, 6),  # 2.0 for an exact title, 1.0 otherwise
            "snippet": None,
            "source": "title",
            "title": record["title"],
        })
    return hits
