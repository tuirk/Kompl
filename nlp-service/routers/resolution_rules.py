"""Rules the resolver layers use to judge whole names (routers/resolution.py).

- Content words: what a Layer 2 auto-merge needs the two names to share.
  Embedding similarity scores siblings and opposites as high as paraphrases:
  "North Korea" / "South Korea" and "Vilnius City Hall" / "Vilnius Town
  Hall" pass every number and word-extension guard, so only the cosine told
  them apart (audit 2026-10-23). Layer 2 now merges on similarity only when
  the names say the same words; everything else goes to Layer 3.
- Hubs: a short name that matches two names which do not match each other
  ("Paul" / "Paul Graham" / "Paul Allen") joined whichever came first and
  chained the two into one group.
- Majority kind: a group took its first member's kind, so the order the
  extractions finished decided between a concept page and an entity page.
- Tickers: "ETH" / "Ethereum" scored under Layer 2's band and the acronym
  rule read initials only, so the pair was never asked about; the alias
  screen (app/src/lib/alias-shapes.ts) already kept it for Layer 3.
- Added words: a name that is a page title plus words ("APCA contrast
  algorithm" / "APCA") scored under the band too, and the compile made a
  second page (replay gate, 2026-10-23). WordBagIndex finds those titles.

Pure functions on strings and indices; nothing here imports the router.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from itertools import combinations

# Words that carry no meaning of their own in a name: "The Beatles" and
# "Beatles", "Bank of England" and "Bank England" say the same words.
_STOPWORDS = frozenset({"a", "an", "the", "of", "and", "or", "for", "in", "on", "at", "to", "by", "with", "from"})


def fold(text: str) -> str:
    """Accents and case folded: "Zürich" → "zurich", "Straße" → "strasse"."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def content_words(name: str) -> list[str]:
    """The words of a name that carry meaning, in order, accents and case
    folded and stopwords dropped: "The Zürich Opera House" → zurich, opera,
    house."""
    s = fold(name).replace("’", "'")
    s = re.sub(r"'s(?![^\W_])", "", s)                 # possessive
    s = re.sub(r"(?<=[^\W\d_]{2})(?=[0-9])", " ", s)    # gpt4 → gpt 4
    return [w for w in re.findall(r"[^\W_]+", s) if w not in _STOPWORDS]


def _same_word(x: str, y: str, *, person: bool) -> bool:
    """One word, or one word and its simple plural ("model" / "models",
    "query" / "queries", "process" / "processes"). People get no plurals:
    "John Edward" and "John Edwards" are two people."""
    if x == y:
        return True
    if person:
        return False
    short, long = sorted((x, y), key=len)
    if len(short) < 3:
        return False
    if long == short + "s":
        return not short.endswith("s")
    if long == short + "es":
        return short.endswith(("s", "x", "z", "ch", "sh"))
    return short.endswith("y") and long == short[:-1] + "ies"


def content_words_agree(names_a: Iterable[str], names_b: Iterable[str], *, person: bool = False) -> bool:
    """Some name of one side says the same content words as some name of
    the other, word by word ("Zurich" / "Zürich", "Large Language Model" /
    "large language models", "Bank of England" / "Bank England").
    "North Korea" / "South Korea", "Machine translation" / "Automatic
    translation" and "ML" / "Machine Learning" do not."""
    words_b = [content_words(y) for y in names_b]
    for x in names_a:
        wx = content_words(x)
        for wy in words_b:
            if wx and len(wx) == len(wy) and all(_same_word(p, q, person=person) for p, q in zip(wx, wy)):
                return True
    return False


def majority_kind(kinds: Iterable[tuple[str, int]]) -> str:
    """The kind most of a group's weight carries; a tie goes to the kind
    first in alphabetical order, so the same members always give the same
    kind whatever order they arrive in."""
    totals: Counter[str] = Counter()
    for kind, weight in kinds:
        totals[kind] += weight
    return min(totals, key=lambda kind: (-totals[kind], kind))


def hubs(partners: dict[int, list[int]], linked: Callable[[int, int], bool]) -> set[int]:
    """The names that match two names which do not match each other.

    `partners[i]` lists the names i matches, its exact duplicates left out;
    `linked(j, k)` says whether two of them match. A hub joins neither side
    ("Paul" between "Paul Graham" and "Paul Allen"), so the groups no longer
    depend on which pair came first, and every group left is a set of names
    that all match one another."""
    return {i for i, js in partners.items() if any(not linked(j, k) for j, k in combinations(js, 2))}


# ---------------------------------------------------------------------------
# Tickers and word initials, as the alias screen reads them
# (expansionWords and acronymPair in app/src/lib/alias-shapes.ts)
# ---------------------------------------------------------------------------

_EXPANSION_STOPWORDS = _STOPWORDS | {"as", "via", "vs"}


def expansion_words(name: str) -> list[str]:
    """A long name's words, accents and case folded, anything but letters
    and digits dropped inside a word, stopwords left out: "Generative
    Pre-trained Transformer" → generative, pretrained, transformer."""
    s = unicodedata.normalize("NFD", name)
    s = "".join(c for c in s if not unicodedata.category(c).startswith("M")).lower()
    words = ("".join(c for c in w if c.isalnum()) for w in s.split())
    return [w for w in words if w and w not in _EXPANSION_STOPWORDS]


def is_ticker(name: str) -> bool:
    """Two to six capital letters and nothing else: "ETH", "UNESCO"."""
    s = name.strip()
    return 2 <= len(s) <= 6 and all(unicodedata.category(c) == "Lu" for c in s)


def ticker_initials(name: str) -> str | None:
    """The initials of a name's words without stopwords, when a ticker
    could spell them: "United Nations Educational, Scientific and Cultural
    Organization" → "unesco"."""
    words = expansion_words(name)
    initials = "".join(w[0] for w in words)
    return initials if len(words) >= 2 and len(initials) <= 6 else None


def ticker_prefixes(name: str) -> list[str]:
    """The starts of a name's first word a ticker could be: "Ethereum" →
    et, eth, ethe, ether, ethere."""
    words = expansion_words(name)
    return [words[0][:k] for k in range(2, min(6, len(words[0])) + 1)] if words else []


def ticker_abbreviates(short: str, long: str) -> bool:
    """`short` is a ticker that gives the initials of `long`'s words without
    stopwords ("UNESCO") or starts its first word ("ETH" / "Ethereum")."""
    if not is_ticker(short):
        return False
    letters = short.strip().lower()
    words = expansion_words(long)
    return bool(words) and ("".join(w[0] for w in words) == letters or words[0].startswith(letters))


# ---------------------------------------------------------------------------
# Names that add words to a page title
# ---------------------------------------------------------------------------


def adds_words(longer: Sequence[str], shorter: Sequence[str]) -> bool:
    """`longer` holds every word of `shorter`, as often, and more:
    "APCA contrast algorithm" / "APCA"."""
    big, small = Counter(longer), Counter(shorter)
    return bool(small) and big != small and not (small - big)


class WordBagIndex:
    """Finds the indexed titles a name adds words to (adds_words).

    Each title is filed under its rarest word. A name holding all of a
    title's words holds that one too, so looking up the name's own words
    finds every such title, and each title is looked at through one word
    only, however common its other words are."""

    def __init__(self, titles: Sequence[Sequence[str]]) -> None:
        self.titles = [list(t) for t in titles]
        counts = Counter(w for t in self.titles for w in set(t))
        self.by_word: dict[str, list[int]] = {}
        for k, t in enumerate(self.titles):
            if t:
                rarest = min(set(t), key=lambda w: (counts[w], w))
                self.by_word.setdefault(rarest, []).append(k)

    def contained_in(self, words: Sequence[str]) -> list[int]:
        """The titles `words` adds words to, in index order."""
        found = {k for w in set(words) for k in self.by_word.get(w, ())}
        return sorted(k for k in found if adds_words(words, self.titles[k]))
