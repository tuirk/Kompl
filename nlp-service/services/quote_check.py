"""Soft check of the source quotes an extraction carries (plan 3.2, D4).

Claims and relationships carry ``quote``: the source sentence the LLM says
it copied. The check never drops anything. It sets ``quote_verified``, and a
verified quote is stored as the source's own text (its case, without
markdown), so a quote shown as "quoted" is always the source's wording:

  exact   the quote, normalised, is in the source, normalised; with an
          ellipsis, each part is, in order.
  fuzzy   quotes of QUOTE_FUZZY_MIN_CHARS or more: the best window of the
          source scores QUOTE_FUZZY_MIN_SCORE or more on rapidfuzz
          partial_ratio, i.e. at most about 1 character in 10 differs. The
          quote becomes that window of the source, widened to whole words.
  else    the quote is kept as the LLM wrote it, quote_verified False.
  none    no quote: quote_verified None.

Normalising (both sides): Unicode NFKC; curly quotes, dashes and odd spaces
folded to plain ones; markdown links, images, emphasis, headings, table bars
and HTML tags reduced to their text; citation markers like "[12]" dropped;
whitespace collapsed; case ignored. No stemming or synonyms, which could
certify words the source does not use.

Why 90: LangExtract (Google) accepts fuzzy alignments at 0.75 token coverage,
but it is locating the span a paraphrase came from. Here "verified" means the
sentence is shown as the source's own words, so the bar is near-verbatim
(llmground's default floor is 0.85), and what is stored is the source's
window, never the LLM's variant. Short quotes need an exact match: on a few
words one changed character is a large share and fuzzy scores mislead.

This module NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Protocol

from rapidfuzz import fuzz

QUOTE_FUZZY_MIN_SCORE = 90.0
QUOTE_FUZZY_MIN_CHARS = 24
# Each part of an ellipsis quote must be at least this long to count.
_ELLIPSIS_PART_MIN_CHARS = 8

_FOLD = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "«": '"', "»": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "―": "-", "−": "-",
    " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
    "­": None, "​": None, "‌": None, "‍": None, "﻿": None,
})

_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)")
_MD_REF_LINK = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
_HTML_TAG = re.compile(r"<[^>\n]{1,200}>")
_CITATION = re.compile(r"[ 	]*\[(?:\d{1,4}|[a-z]|citation needed|note \d{1,3})\]", re.IGNORECASE)
_LINE_MARK = re.compile(r"(?m)^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)")
# Emphasis marks at a word's edge ("**bold**", "_term_"), not inside a word
# ("snake_case"); code ticks and strike-through anywhere.
_EMPHASIS = re.compile(r"(?<!\w)[*_]+|[*_]+(?!\w)|`+|~~")
_TABLE_BAR = re.compile(r"\|")
_SPACES = re.compile(r"\s+")
_ELLIPSIS = re.compile(r"\.\.\.|…")
# Quote marks around a quote and the punctuation that ends it: transcripts
# and line-broken text often have no full stop where the LLM adds one.
_QUOTE_EDGES = re.compile(r"^[\s\"']+|[\s\"'.,;:!?]+$")
_SENTENCE_END = ".!?"


def _plain(text: str) -> str:
    """Text without formatting, case kept: the form a stored quote takes."""
    text = unicodedata.normalize("NFKC", text).translate(_FOLD)
    text = _MD_IMAGE.sub(r"\1", text)
    text = _MD_LINK.sub(r"\1", text)
    text = _MD_REF_LINK.sub(r"\1", text)
    text = _HTML_TAG.sub(" ", text)
    text = _CITATION.sub("", text)
    text = _LINE_MARK.sub("", text)
    text = _EMPHASIS.sub("", text)
    text = _TABLE_BAR.sub(" ", text)
    return _SPACES.sub(" ", text).strip()


def _fold_case(text: str) -> str:
    """Lowercase without changing the length, so positions map back."""
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


class SourceText:
    """One source, normalised once for every quote checked against it."""

    def __init__(self, markdown: str) -> None:
        self.plain = _plain(markdown)
        self.folded = _fold_case(self.plain)


def _whole_words(plain: str, start: int, end: int) -> str:
    """The window widened to the words it cuts into."""
    while start > 0 and not plain[start - 1].isspace():
        start -= 1
    while end < len(plain) and not plain[end].isspace():
        end += 1
    return plain[start:end].strip()


def _window(plain: str, start: int, end: int) -> str:
    """The source's text at [start, end), with the full stop that ends it."""
    if end < len(plain) and plain[end] in _SENTENCE_END:
        end += 1
    return plain[start:end]


def check_quote(quote: str | None, source: SourceText) -> tuple[str | None, bool | None]:
    """(quote to store, verified) for one quote; see the module docstring.
    A verified quote is stored in the source's wording (its case, without
    markdown); an unverified one as the LLM wrote it."""
    if quote is None or not quote.strip():
        return None, None
    written = quote.strip()
    folded = _QUOTE_EDGES.sub("", _fold_case(_plain(written)))
    if not folded:
        return written, False
    at = source.folded.find(folded)
    if at >= 0:
        return _window(source.plain, at, at + len(folded)), True

    parts = [p.strip() for p in _ELLIPSIS.split(folded)]
    parts = [p for p in parts if p]
    if len(parts) > 1 and all(len(p) >= _ELLIPSIS_PART_MIN_CHARS for p in parts):
        pieces: list[str] = []
        at = 0
        for part in parts:
            found = source.folded.find(part, at)
            if found < 0:
                break
            pieces.append(_window(source.plain, found, found + len(part)))
            at = found + len(part)
        else:
            return " ... ".join(pieces), True

    if len(folded) >= QUOTE_FUZZY_MIN_CHARS:
        hit = fuzz.partial_ratio_alignment(
            folded, source.folded, score_cutoff=QUOTE_FUZZY_MIN_SCORE
        )
        if hit is not None:
            return _whole_words(source.plain, hit.dest_start, hit.dest_end), True
    return written, False


def skeleton(name: str) -> str:
    """The name without case, spaces, hyphens or punctuation; "+" and "#"
    stay. The same rule as routers/resolution.py _skeleton, which this
    module does not import (it loads the resolver's models)."""
    return re.sub(r"[^\w+#]|_", "", unicodedata.normalize("NFKC", name).lower())


class _Quoted(Protocol):
    quote: str | None
    quote_verified: bool | None


class _Relation(_Quoted, Protocol):
    from_entity: str
    to: str
    ends_listed: bool | None


@dataclass
class QuoteReport:
    """What the check found in one extraction (for the log line)."""
    claims: int = 0
    claims_quoted: int = 0
    claims_verified: int = 0
    relations: int = 0
    relations_quoted: int = 0
    relations_verified: int = 0
    unlisted_ends: tuple[str, ...] = ()


def _check_all(items: Iterable[_Quoted], source: SourceText) -> tuple[int, int, int]:
    total = quoted = verified = 0
    for item in items:
        total += 1
        item.quote, item.quote_verified = check_quote(item.quote, source)
        quoted += item.quote is not None
        verified += item.quote_verified is True
    return total, quoted, verified


def check_extraction(
    claims: Iterable[_Quoted],
    relations: Iterable[_Relation],
    listed_names: Iterable[str],
    markdown: str,
) -> QuoteReport:
    """Check every claim and relationship quote in place, and mark each
    relationship whose two ends are names from the extraction's own entity
    and concept lists (compared by skeleton). Nothing is dropped: an end
    outside the lists is only counted, until a measured run decides."""
    source = SourceText(markdown)
    relations = list(relations)
    report = QuoteReport()
    report.claims, report.claims_quoted, report.claims_verified = _check_all(claims, source)
    report.relations, report.relations_quoted, report.relations_verified = _check_all(relations, source)

    listed = {skeleton(n) for n in listed_names if n and n.strip()}
    unlisted: list[str] = []
    for rel in relations:
        outside = [n for n in (rel.from_entity, rel.to) if skeleton(n) not in listed]
        rel.ends_listed = not outside
        unlisted.extend(n for n in outside if n not in unlisted)
    report.unlisted_ends = tuple(unlisted)
    return report
