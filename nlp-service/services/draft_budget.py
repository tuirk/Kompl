"""Prompt budget for draft_page: which source documents fit, and what was cut.

draft_page used to cut the finished prompt at the budget, so whatever came
last lost its text, often this session's own source, while the commit still
recorded every source as a contributor (audit B4). Now the fixed parts of
the prompt (instructions, the existing page, the dossier, link titles) stay
whole, and the source documents share what is left:

- This session's sources (``is_new``) go first and in full. Only when they
  alone overflow do they share the room evenly, each cut at a paragraph
  break; rather than give each a sliver, the last ones are left out.
- Older sources share what remains, most relevant first: each one that fits
  goes in whole, the first that does not is shortened when at least
  MIN_PARTIAL_SOURCE_CHARS of room remain, and the rest are left out.
  Relevance is TF-IDF similarity to the page (its title plus its existing
  text); the caller's order breaks ties and is the fallback.
- When older sources had to be ranked, the kept ones are placed most
  relevant last, next to the final rules: models use the start and the end
  of a long prompt best and miss details in the middle (Liu et al., "Lost in
  the Middle", TACL 2024, arXiv 2307.03172).

Pure functions apart from the lazy scikit-learn import; no LLM, no I/O.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

# An older source shortened below this is left out instead: a few lines from
# the top of an article rarely say anything about the page's subject.
MIN_PARTIAL_SOURCE_CHARS = 2_000

# The source documents always get at least this much room, even when the
# fixed parts of the prompt already fill the budget (a draft without this
# session's sources has nothing to add). The prompt then runs over the
# budget by at most this much.
MIN_SOURCE_ROOM_CHARS = 8_000

# Room kept for the "(shortened: first N of M characters)" note a cut source
# carries in its header (llm_client._source_header).
SHORTENED_NOTE_RESERVE = 64

# Newlines around one source block when the prompt parts are joined.
BLOCK_OVERHEAD_CHARS = 3


@dataclass(frozen=True)
class SourceCut:
    """A source document that did not go into the prompt whole."""

    source_id: str
    sent_chars: int  # characters of its text in the prompt; 0 when left out
    cut_chars: int  # characters of its text not sent


@dataclass(frozen=True)
class FittedSources:
    # Source dicts in prompt order. A shortened one is a copy whose markdown
    # is cut and whose "shortened_from" holds its full length.
    sources: list[dict[str, Any]] = field(default_factory=list)
    cuts: list[SourceCut] = field(default_factory=list)  # in the caller's order


def cut_text(text: str, limit: int) -> str:
    """The start of ``text`` within ``limit`` characters, ending at a
    paragraph, line or sentence break when one falls in the second half."""
    if len(text) <= limit:
        return text
    window = text[: max(0, limit)]
    for sep in ("\n\n", "\n", ". "):
        pos = window.rfind(sep)
        if pos >= limit // 2:
            return window[: pos + (1 if sep == ". " else 0)].rstrip()
    return window.rstrip()


def rank_by_relevance(query: str, sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``sources`` most similar to ``query`` first (TF-IDF cosine, same
    settings as POST /extract/tfidf-rank). Ties keep the given order, which
    is also the answer when ranking is not possible."""
    if len(sources) < 2 or not query.strip():
        return list(sources)
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer  # noqa: PLC0415
        from sklearn.metrics.pairwise import cosine_similarity  # noqa: PLC0415

        docs = [query] + [str(sc.get("markdown", "")) for sc in sources]
        matrix = TfidfVectorizer(max_features=5000, stop_words="english").fit_transform(docs)
        scores = cosine_similarity(matrix[0], matrix[1:])[0].tolist()
    except Exception as e:  # noqa: BLE001 — no vocabulary, no scikit-learn: keep the given order
        logger.warning("draft source ranking failed (%s); keeping the given order", e)
        return list(sources)
    order = sorted(range(len(sources)), key=lambda i: -scores[i])
    return [sources[i] for i in order]


def _even_shares(costs: list[int], room: int) -> list[int]:
    """Split ``room`` so no one gets more than its cost and the rest share
    the remainder equally (smallest first, max-min fair)."""
    shares = [0] * len(costs)
    left = room
    for n, i in enumerate(sorted(range(len(costs)), key=lambda i: costs[i])):
        share = min(costs[i], left // (len(costs) - n))
        shares[i] = share
        left -= share
    return shares


def fit_sources(
    sources: list[dict[str, Any]],
    room: int,
    header_chars: Callable[[dict[str, Any]], int],
    relevance_query: str,
) -> FittedSources:
    """Choose the source documents for a prompt with ``room`` characters
    left for them (see the module docstring for the order and the rules)."""
    text_of = {id(sc): str(sc.get("markdown", "")) for sc in sources}

    def cost(sc: dict[str, Any]) -> int:
        return header_chars(sc) + len(text_of[id(sc)]) + BLOCK_OVERHEAD_CHARS

    def allowance(sc: dict[str, Any], block_room: int) -> int:
        """Characters of text a shortened block of ``block_room`` can hold."""
        return block_room - header_chars(sc) - BLOCK_OVERHEAD_CHARS - SHORTENED_NOTE_RESERVE

    sent: dict[int, int] = {}  # id(sc) -> characters of text sent

    new = [sc for sc in sources if sc.get("is_new")]
    older = [sc for sc in sources if not sc.get("is_new")]

    new_costs = [cost(sc) for sc in new]
    if sum(new_costs) <= room:
        for sc in new:
            sent[id(sc)] = len(text_of[id(sc)])
        left = room - sum(new_costs)
    else:
        # Even shares, but never slivers: while a share would hold less than
        # MIN_PARTIAL_SOURCE_CHARS, the last new source in the given order
        # is left out and the others share again. The first always stays.
        k = len(new)
        while True:
            shares = _even_shares(new_costs[:k], room)
            short = any(
                s < c and allowance(sc, s) < MIN_PARTIAL_SOURCE_CHARS
                for sc, c, s in zip(new, new_costs, shares)
            )
            if not short or k == 1:
                break
            k -= 1
        for sc, c, share in zip(new, new_costs, shares + [0] * (len(new) - k)):
            sent[id(sc)] = len(text_of[id(sc)]) if share >= c else max(0, allowance(sc, share))
        left = 0

    ranked = False
    if sum(cost(sc) for sc in older) <= left:
        kept_older = older
        for sc in older:
            sent[id(sc)] = len(text_of[id(sc)])
    else:
        ranked = True
        kept_older = []
        for sc in rank_by_relevance(relevance_query, older):
            c = cost(sc)
            if c <= left:
                sent[id(sc)] = len(text_of[id(sc)])
                left -= c
            elif allowance(sc, left) >= MIN_PARTIAL_SOURCE_CHARS:
                sent[id(sc)] = allowance(sc, left)
                left = 0
            else:
                sent[id(sc)] = 0
                continue
            kept_older.append(sc)
        # Most relevant last, right before the final rules.
        kept_older.reverse()

    fitted: list[dict[str, Any]] = []
    cuts: list[SourceCut] = []
    for sc in new + kept_older:
        full = text_of[id(sc)]
        n = sent[id(sc)]
        if n <= 0:
            continue
        if n >= len(full):
            fitted.append(sc)
            continue
        text = cut_text(full, n)
        sent[id(sc)] = len(text)
        fitted.append({**sc, "markdown": text, "shortened_from": len(full)})
    for sc in sources:
        full_len = len(text_of[id(sc)])
        n = min(sent.get(id(sc), 0), full_len)
        if n < full_len:
            cuts.append(SourceCut(source_id=str(sc.get("source_id", "")), sent_chars=n, cut_chars=full_len - n))
    if cuts:
        logger.info(
            "draft prompt budget: %d of %d sources cut (%d chars left out)%s",
            len(cuts), len(sources), sum(c.cut_chars for c in cuts),
            "; older sources ranked by relevance" if ranked else "",
        )
    return FittedSources(sources=fitted, cuts=cuts)
