"""Entity resolution endpoints — Part 2b.

Three-layer cascading matcher that resolves entity duplicates across sources
in a session:

  POST /resolve/fuzzy         — Layer 1: spellings of one name (exact,
                                  skeleton, plural, near-spelling, "Full
                                  Name (ABBR)"), existing aliases and page
                                  titles
  POST /resolve/embedding     — Layer 2: sentence-transformers cosine similarity
  POST /resolve/disambiguate  — Layer 3: Gemini LLM for 0.7–0.9 ambiguous band

Layer 2 receives the entities Layer 1 left unresolved plus Layer 1's groups,
so a grouped or page-bound name is still compared with the rest of the
session; Layer 3 receives the pairs Layer 2 could not decide. The
orchestrator (POST /api/compile/resolve in Next.js) drives the cascade.

Implementation notes:
  - Union-Find groups entities that match on ANY of the fuzzy criteria, but
    names whose numbers differ (Python 2 / Python 3) never merge, and names
    where one only adds words to the other (Ethereum / Ethereum Foundation)
    are left to Layers 2/3 unless both are people. Every group is a set of
    names that all match one another (complete linkage).
  - An acronym or ticker and its expansion ("ML" / "Machine Learning",
    "ETH" / "Ethereum") and single words one letter apart ("Wikipedia" /
    "Wikimedia") never merge on spelling (_layer3_only_method); Layer 2
    asks Layer 3 about them, and about a name that adds words to a page
    title ("APCA contrast algorithm" / "APCA"), whatever their similarity.
  - Canonical name = the name most sources use; for people, the fullest name.
  - Embedding model is a lazy singleton — loaded once on first /resolve/embedding call.
  - Compatible types for cross-type matching: {ORG, PRODUCT} and {CONCEPT, OTHER}.
    PERSON entities only match other PERSON entities. Layer 2 also compares a
    CONCEPT with ORG/PRODUCT/PERSON/LOCATION/EVENT, but only Layer 3 merges them.
"""

from __future__ import annotations

import logging
import re
import threading
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from routers.resolution_rules import (
    WordBagIndex,
    content_words_agree,
    hubs,
    is_ticker,
    majority_kind,
    ticker_abbreviates,
    ticker_initials,
    ticker_prefixes,
)
from routers.resolution_spelling import us_spelling
from services.llm_models import LLMModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["resolution"])

# ---------------------------------------------------------------------------
# Lazy embedding model singleton
# ---------------------------------------------------------------------------

_embed_model: Any = None
# The startup warm-up (main.py) loads the model in a background thread; a
# request arriving meanwhile waits for that load instead of starting another.
_embed_model_lock = threading.Lock()


def _get_embed_model() -> Any:
    global _embed_model
    if _embed_model is None:
        with _embed_model_lock:
            if _embed_model is None:
                from sentence_transformers import SentenceTransformer
                logger.info("Loading SentenceTransformer all-MiniLM-L6-v2 for entity resolution...")
                _embed_model = SentenceTransformer("all-MiniLM-L6-v2")
                logger.info("Embedding model loaded.")
    return _embed_model


# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------


class EntityInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str
    type: str
    source_id: str
    context: str = ""


class ResolvedGroup(BaseModel):
    model_config = ConfigDict(extra='forbid')
    canonical: str
    type: str
    aliases: list[str]
    source_ids: list[str]
    method: str   # "exact"|"skeleton"|"plural"|"levenshtein"|"jaro_winkler"|"parenthetical"|"person_subset"|"person_initials"|"existing_alias"|"embedding"|"existing_page_title"


class ExistingPageTitle(BaseModel):
    """Anchor for cross-session matching: an entity/concept page that already
    exists in the wiki. Layer 1 fuzzy and Layer 2 embedding compare incoming
    session entities against these titles, so a singleton "GPT 4" in session
    B resolves to the existing "GPT-4" page without needing a prior in-session
    merge to populate the aliases table.
    """
    model_config = ConfigDict(extra='forbid')
    title: str
    page_type: str  # 'entity' | 'concept'
    # What the page is about, for the closest-by-meaning candidates (Layer 2).
    # Optional, so older callers still validate.
    summary: str | None = None


# ---------------------------------------------------------------------------
# Union-Find helper
# ---------------------------------------------------------------------------


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x: int, y: int) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx == ry:
            return
        if self.rank[rx] < self.rank[ry]:
            rx, ry = ry, rx
        self.parent[ry] = rx
        if self.rank[rx] == self.rank[ry]:
            self.rank[rx] += 1


# ---------------------------------------------------------------------------
# Type compatibility check
# ---------------------------------------------------------------------------

_COMPATIBLE_TYPE_GROUPS: list[frozenset[str]] = [
    frozenset({"ORG", "PRODUCT"}),
    frozenset({"CONCEPT", "OTHER"}),
]


def _types_compatible(t1: str, t2: str) -> bool:
    if t1 == t2:
        return True
    for group in _COMPATIBLE_TYPE_GROUPS:
        if t1 in group and t2 in group:
            return True
    return False


# Entity-type → page-type compatibility for cross-session matching.
# Entity pages cover proper-noun entities (PERSON/ORG/PRODUCT/LOCATION/EVENT)
# plus OTHER as catchall. Concept pages cover CONCEPT plus OTHER as catchall.
# OTHER appears in both so the catchall can resolve either way.
_ENTITY_PAGE_TYPES = frozenset({"PERSON", "ORG", "PRODUCT", "LOCATION", "EVENT", "OTHER"})
_CONCEPT_PAGE_TYPES = frozenset({"CONCEPT", "OTHER"})


def _entity_matches_page_type(entity_type: str, page_type: str) -> bool:
    if page_type == "entity":
        return entity_type in _ENTITY_PAGE_TYPES
    if page_type == "concept":
        return entity_type in _CONCEPT_PAGE_TYPES
    return False


# ---------------------------------------------------------------------------
# Fuzzy matching helpers
# ---------------------------------------------------------------------------


def _initials(name: str) -> str | None:
    """The first letters of a name of two or more words, in capitals:
    "Web Content Accessibility Guidelines" → "WCAG"."""
    words = name.split()
    if len(words) < 2:
        return None
    return "".join(w[0] for w in words if w).upper()


def _is_acronym(short: str, long: str) -> bool:
    """`short`, written in capitals, spells the initials of `long`: "ML" /
    "Machine Learning". In lower case it is usually a word ("it" /
    "Information Technology", "art" / "Adaptive Resonance Theory")."""
    initials = _initials(long)
    return initials is not None and short.isupper() and short.upper() == initials


# ---------------------------------------------------------------------------
# Name guard: numbers and token extensions
#
# Edit-distance and substring signals can't tell a thing from its version or
# its parent: "Python 3"/"Python 2" are one character apart, "Ethereum" sits
# inside "Ethereum Foundation". The 2026-10-09 e2e run stored exactly those
# merges. Mirrored in app/src/lib/name-guard.ts (stored aliases are filtered
# with the same rule); tests/fixtures/name_guard_cases.json keeps them equal.
# ---------------------------------------------------------------------------

_ROMAN = re.compile(r"(?<![A-Za-z0-9])[IVX]{2,}(?![A-Za-z0-9])")
_ROMAN_VALID = re.compile(r"X{0,3}(?:IX|IV|V?I{0,3})")
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10}


def _roman_to_int(numeral: str) -> int:
    total = 0
    for i, ch in enumerate(numeral):
        value = _ROMAN_VALUES[ch]
        if i + 1 < len(numeral) and _ROMAN_VALUES[numeral[i + 1]] > value:
            total -= value
        else:
            total += value
    return total


def _name_tokens(name: str) -> list[str]:
    """Lower-case word tokens; "GPT4" splits to gpt + 4, "A100" stays whole."""
    s = unicodedata.normalize("NFKC", name).lower().replace("’", "'")
    s = re.sub(r"'s(?![^\W_])", "", s)                       # possessive
    s = re.sub(r"(?<=[0-9]),(?=[0-9]{3}(?![0-9]))", "", s)    # 1,000 → 1000
    s = re.sub(r"(?<=[^\W\d_]{2})(?=[0-9])", " ", s)          # gpt4 → gpt 4
    return re.findall(r"[^\W_]+(?:\.[0-9]+)*", s)


def _numeric_signature(name: str) -> Counter[str]:
    """The numbers in a name: versions ("3.10", "v2" → "2"), model codes
    ("4o", "a100") and Roman numerals II–XXXIX ("World War II" → "2")."""
    sig: Counter[str] = Counter()
    for tok in _name_tokens(name):
        if not re.search(r"[0-9]", tok):
            continue
        tok = re.sub(r"^v(?=[0-9])", "", tok)
        if re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", tok):
            parts = [int(p) for p in tok.split(".")]
            while len(parts) > 1 and parts[-1] == 0:   # 3.0 == 3, 3.10 != 3.1
                parts.pop()
            sig[".".join(str(p) for p in parts)] += 1
        else:
            sig[tok] += 1
    for m in _ROMAN.finditer(unicodedata.normalize("NFKC", name)):
        if _ROMAN_VALID.fullmatch(m.group(0)):
            sig[str(_roman_to_int(m.group(0)))] += 1
    return sig


def _numeric_conflict(a: str, b: str) -> str | None:
    """None when both names carry the same numbers; "hard" when both carry
    numbers that differ (Python 2 / Python 3); "soft" when only one does
    (Python / Python 2)."""
    sa, sb = _numeric_signature(a), _numeric_signature(b)
    if sa == sb:
        return None
    return "hard" if sa and sb else "soft"


def _is_token_extension(a: str, b: str) -> bool:
    """One name is the other plus extra words: "Ethereum" / "Ethereum
    Foundation", "Karpathy" / "Andrej Karpathy"."""
    ta, tb = Counter(_name_tokens(a)), Counter(_name_tokens(b))
    if not ta or not tb or ta == tb:
        return False
    return not (ta - tb) or not (tb - ta)


def _person_initials(a: str, b: str) -> bool:
    """Same surname and the other names equal or initials: "A. Karpathy" /
    "Andrej Karpathy"."""
    ta, tb = _name_tokens(a), _name_tokens(b)
    if len(ta) != len(tb) or len(ta) < 2 or ta[-1] != tb[-1]:
        return False
    return all(
        x == y or (len(x) == 1 and y.startswith(x)) or (len(y) == 1 and x.startswith(y))
        for x, y in zip(ta[:-1], tb[:-1])
    )


def _person_names_clash(a: str, b: str) -> bool:
    """Two full names with the same surname but different first names
    ("Bob Karpathy" / "Andrej Karpathy")."""
    ta, tb = _name_tokens(a), _name_tokens(b)
    if len(ta) < 2 or len(tb) < 2 or ta[-1] != tb[-1]:
        return False
    fa, fb = ta[0], tb[0]
    if fa == fb or (len(fa) == 1 and fb.startswith(fa)) or (len(fb) == 1 and fa.startswith(fb)):
        return False
    from rapidfuzz.distance import Levenshtein
    return Levenshtein.distance(fa, fb) > 1


# ---------------------------------------------------------------------------
# Spelling rules: what Layer 1 may merge on its own
#
# Edit distance and Jaro-Winkler over whole names merged different things
# that are spelt alike: "NVDA" / "NAVA" and "WebKit" / "WebAIM" (Levenshtein
# ≤ 2), "vestibular motion triggers" / "vestibular motion disorders" and
# "anti-aliasing and font weight" / "Antialiasing and font smoothing"
# (Jaro-Winkler ≥ 0.92) — 2026-10-17, session 61c8bb37. Layer 1 now merges
# only spellings of one name; everything else goes on to Layer 2.
# ---------------------------------------------------------------------------


def _skeleton(name: str) -> str:
    """The name without case, spaces, hyphens or punctuation: "GPT-4",
    "GPT 4" and "gpt4" all give "gpt4". "+" and "#" stay, so C, C++ and C#
    keep apart."""
    return re.sub(r"[^\w+#]|_", "", unicodedata.normalize("NFKC", name).lower())


def _is_simple_plural(a: str, b: str) -> bool:
    """One name is the other plus a plural ending: "LLM" / "LLMs", "CSS media
    query" / "CSS media queries", "process" / "processes"."""
    sa, sb = _skeleton(a), _skeleton(b)
    if len(sa) > len(sb):
        a, b, sa, sb = b, a, sb, sa
    if len(sa) < 3:
        # Two letters only as a capitalised acronym: "AI" / "AIs".
        return len(sa) == 2 and a.isupper() and b == a + "s"
    if sb == sa + "s":
        return not sa.endswith("s")
    if sb == sa + "es":
        return sa.endswith(("s", "x", "z", "ch", "sh"))
    return sa.endswith("y") and sb == sa[:-1] + "ies"


def _word_key(word: str) -> str:
    """A word with its number read as the name guard reads it: "2.0" and
    "v2" are both "2", so "WCAG 2" / "WCAG 2.0" keep one head word."""
    m = re.fullmatch(r"v?([0-9]+(?:\.[0-9]+)*)", word)
    if not m:
        return word
    parts = [int(p) for p in m.group(1).split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return ".".join(str(p) for p in parts)


def _same_words_but_spelling(ta: list[str], tb: list[str]) -> bool:
    """Word by word the same name: the head (last) word equal or a plural,
    every other word equal, a plural, or one letter off in a word of five or
    more ("colour" / "color"). "North America" / "South America" and "Kaunas
    City Hall" / "Kaunas City Museum" fail; Levenshtein and Jaro-Winkler over
    the whole name pass both."""
    from rapidfuzz.distance import Levenshtein

    ta, tb = [_word_key(t) for t in ta], [_word_key(t) for t in tb]
    if len(ta) != len(tb) or not (ta[-1] == tb[-1] or _is_simple_plural(ta[-1], tb[-1])):
        return False
    return all(
        x == y or _is_simple_plural(x, y) or (min(len(x), len(y)) >= 5 and Levenshtein.distance(x, y) == 1)
        for x, y in zip(ta[:-1], tb[:-1])
    )


def _spelling_method(a: str, b: str, *, person: bool = False) -> str | None:
    """How a and b spell one name, or None. Callers have already ruled out
    equal names, names whose numbers differ and names that extend one
    another. People match only by skeleton: a plural or a one-letter edit
    inside a name is another person ("John Edward" / "John Edwards",
    "Louis Martin" / "Louise Martin"). An acronym and a single word one
    letter off are not spellings either: see _layer3_only_method."""
    from rapidfuzz.distance import JaroWinkler, Levenshtein

    sa, sb = _skeleton(a), _skeleton(b)
    if sa and sa == sb:
        return "skeleton"
    if person:
        return None
    if _is_simple_plural(a, b):
        return "plural"

    ta, tb = _name_tokens(a), _name_tokens(b)
    al, bl = a.lower(), b.lower()
    if len(ta) >= 2 and len(tb) >= 2 and _same_words_but_spelling(ta, tb):
        if Levenshtein.distance(al, bl) <= 2:
            return "levenshtein"
        if JaroWinkler.similarity(al, bl) >= 0.92:
            return "jaro_winkler"
    return None


def _is_acronym_pair(a: str, b: str) -> bool:
    """An acronym or ticker and its expansion, either way round: a name in
    capitals that spells the initials of the other's words ("ML" / "Machine
    Learning", "LOTR" / "Lord of the Rings"), or two to six capitals that
    spell the initials of its words without stopwords ("UNESCO") or start
    its first word ("ETH" / "Ethereum"). Never a spelling, a plural, a name
    plus words ("AI" / "AI Act") or names whose numbers differ. The alias
    screen keeps exactly these pairs for Layer 3 (acronymPair in
    app/src/lib/alias-shapes.ts); tests/fixtures/acronym_pair_cases.json
    holds the two to the same cases."""
    if not (_is_acronym(a, b) or _is_acronym(b, a) or ticker_abbreviates(a, b) or ticker_abbreviates(b, a)):
        return False
    return not (_skeleton(a) == _skeleton(b) or _numeric_conflict(a, b) or _is_simple_plural(a, b)
                or _is_token_extension(a, b))


def _layer3_only_method(a: str, b: str, *, person: bool = False) -> str | None:
    """Pairs Layer 1 merged on spelling alone until 2026-10-23 and now only
    asks Layer 3 about, whatever their similarity (resolve_embedding):
      - "acronym": an acronym or ticker and its expansion (_is_acronym_pair:
        "ML" / "Machine Learning", "ETH" / "Ethereum"). Most acronyms stand
        for several things ("CI" is Continuous Integration and Confidence
        Interval), and a bare match chained them into one group (owner
        decision 2026-10-23);
      - "slip": two long single words one letter apart ("Wikipedia" /
        "Wikimedia", "Columbia" / "Colombia"), usually two things. Not for
        people, whose names never match by an edit.
    Names whose numbers differ are left out; _block_keys finds both kinds."""
    from rapidfuzz.distance import Levenshtein

    sa, sb = _skeleton(a), _skeleton(b)
    if sa == sb or _numeric_conflict(a, b):
        return None
    if _is_acronym_pair(a, b):
        return "acronym"
    if person or (len(_name_tokens(a)) >= 2 and len(_name_tokens(b)) >= 2):
        return None
    if len(sa) >= 8 and len(sb) >= 8 and Levenshtein.distance(sa, sb) == 1:
        return "slip"
    return None


_TRAILING_BRACKET = re.compile(r"^(?P<base>.*[^\s(])\s*\((?P<inner>[^()]+)\)\s*$")


def _split_parenthetical(name: str) -> tuple[str, str] | None:
    """("Web Content Accessibility Guidelines", "WCAG") for "Web Content
    Accessibility Guidelines (WCAG)"; None without a trailing bracket."""
    m = _TRAILING_BRACKET.match(name)
    return (m.group("base").strip(), m.group("inner").strip()) if m else None


def _is_abbreviation(short: str, long: str) -> bool:
    """`short` reads as the abbreviation of `long`: one word in capitals
    whose letters appear in `long` in order, the first one starting it
    ("WCAG" / "Web Content Accessibility Guidelines", "UNESCO" / "United
    Nations Educational, Scientific and Cultural Organization", "ETH" /
    "Ethereum"). A year or a qualifier ("2009", "planet", "UK" after "Labour
    Party") is not."""
    letters = [c for c in short.lower() if c.isalpha()]
    first = next((c for c in long.lower() if c.isalnum()), "")
    if len(letters) < 2 or not short.isupper() or any(c.isspace() for c in short) or letters[0] != first:
        return False
    text, pos = long.lower(), 0
    for c in letters:
        pos = text.find(c, pos) + 1
        if pos == 0:
            return False
    return True


def _parenthetical_match(a: str, b: str) -> str | None:
    """"Full Name (ABBR)" against its full name or its abbreviation: "Web
    Content Accessibility Guidelines (WCAG)" is both "Web Content
    Accessibility Guidelines" and "WCAG", though the bracket reads as one
    more word to the extension guard and the acronym rule (2026-10-17,
    session 61c8bb37). "abbreviation" when the other name is the short
    form, "expansion" when it is the full name, else None. Two names that
    both end in a bracket never match here ("Mercury (planet)" / "Mercury
    (element)"), and neither does a bracket holding a year or a qualifier.

    The source defined one abbreviation for one full name, so only those
    two match: the abbreviation as written in capitals, and the full name
    or a spelling of it. "Continuous Integration (CI)" is not "Confidence
    Interval" and "Machine Learning (ML)" is not "Maximum Likelihood"
    (audit 2026-10-23); a bare initials match goes to Layer 3."""
    if not (a.rstrip().endswith(")") or b.rstrip().endswith(")")):
        return None
    pa, pb = _split_parenthetical(a), _split_parenthetical(b)
    if (pa is None) == (pb is None):
        return None
    (base, inner), other = (pa, b) if pa is not None else (pb, a)
    if not _is_abbreviation(inner, base):
        return None
    if other.isupper() and _skeleton(other) == _skeleton(inner):
        return "abbreviation"
    if _skeleton(other) == _skeleton(base) or _spelling_method(other, base):
        return "expansion"
    return None


def _title_for_similarity(title: str) -> str:
    """A page title as Layer 2 embeds it: without a trailing bracket that
    abbreviates the rest. "Color Vision Deficiency (CVD)" scored 0.54 by
    name against "Colorblindness", 0.68 without the bracket (film run
    2026-10-25). "Mercury (planet)" keeps its bracket; pairs and anchors
    still name the exact title."""
    bracket = _split_parenthetical(title)
    if bracket is not None and _is_abbreviation(bracket[1], bracket[0]):
        return bracket[0]
    return title


def _fuzzy_method(a: str, b: str, *, person_pair: bool = False) -> str | None:
    """Return the best matching method name if a and b should be merged, else None.

    Used for SAME-SESSION pairwise grouping. Names whose numbers differ never
    merge here, and neither do names where one only adds words to the other
    — except two PERSON names ("Karpathy" + "Andrej Karpathy"). Those pairs
    go on to Layer 2/3, which judge meaning rather than spelling, and so do
    names that are merely spelt alike (see _spelling_method).
    """
    al, bl = a.lower(), b.lower()

    # Exact
    if al == bl:
        return "exact"

    if _numeric_conflict(a, b):
        return None

    if _parenthetical_match(a, b):
        return "parenthetical"

    if _is_token_extension(a, b):
        if person_pair:
            shorter = min(_name_tokens(a), _name_tokens(b), key=len)
            if all(len(t) >= 2 for t in shorter):
                return "person_subset"
        return None

    if person_pair and _person_initials(a, b):
        return "person_initials"

    return _spelling_method(a, b, person=person_pair)


def _cross_session_method(a: str, b: str, *, person: bool = False) -> str | None:
    """Stricter variant of _fuzzy_method for cross-session anchoring against
    existing wiki page titles.

    No substring or token-extension matches: one side is an authoritative,
    permanent wiki page title, and extracting "Vilnius" from a new source
    must NOT bind to an existing "Vilnius Cathedral" page. The same shape
    hits cities vs landmarks (London ↔ London Eye, which Jaro-Winkler alone
    scores at exactly 0.92), parents vs subsidiaries, brands vs product
    lines. Names whose numbers differ never bind either (Python 3 must not
    anchor to an existing Python 2 page). Otherwise the same spelling rules
    as in-session grouping apply, without the person rules, and "Full Name
    (ABBR)" binds its full name and its abbreviation (_parenthetical_match).

    Layer 2 sends the legitimate cross-session cases to Layer 3: a name that
    adds words to a page title ("Andrej Karpathy" ↔ existing "Karpathy"
    page) is asked about whatever its similarity (_extension_node_pairs).
    """
    if a.lower() == b.lower():
        return "exact"

    if _numeric_conflict(a, b):
        return None

    if _parenthetical_match(a, b):
        return "parenthetical"

    if _is_token_extension(a, b):
        return None

    return _spelling_method(a, b, person=person)


def _cross_kind_acronym(name: str, title: str) -> bool:
    """A capitalised abbreviation and the page title that defines it in
    brackets, or the other way round ("WCAG" / "Web Content Accessibility
    Guidelines (WCAG)"). Binds across kinds: sources type the short form ORG
    or PRODUCT and the long one CONCEPT. A bare initials match ("WCAG" /
    "Web Content Accessibility Guidelines") binds nothing: Layer 2 asks
    Layer 3 about it (_layer3_only_method)."""
    short, long = sorted((name, title), key=len)
    if not short.isupper():
        return False
    return (_parenthetical_match(short, long) == "abbreviation"
            and _cross_session_method(name, title) == "parenthetical")


# ---------------------------------------------------------------------------
# Blocking: which pairs Layer 1 looks at
#
# Checking every name against every other name and every page title made
# Layer 1 cost entities × pages rule checks: 600 names against 5,000 pages
# took 122 s, past the route's 60 s limit. Every rule above can only match
# two names that share one of the keys below, so Layer 1 checks just the
# pairs that share a key, in the same order as before, and the result is the
# same. A new matching rule needs its key here.
# ---------------------------------------------------------------------------


def _singulars(skeleton: str) -> list[str]:
    """The skeleton and each form it could be a simple plural of:
    "queries" → queries, querie, queri, query."""
    forms = [skeleton]
    if skeleton.endswith("s"):
        forms.append(skeleton[:-1])
    if skeleton.endswith("es"):
        forms.append(skeleton[:-2])
    if skeleton.endswith("ies"):
        forms.append(skeleton[:-3] + "y")
    return forms


def _block_keys(name: str, *, person: bool = False) -> set[tuple[str, str]]:
    """Keys that let _partner_key find every name _fuzzy_method,
    _cross_session_method or _layer3_only_method can match with this one:
      - exact, skeleton and plural: the lower-case name, the skeleton and
        the skeleton without a plural ending;
      - two or more words: the word count and the head word without a
        plural ending (_same_words_but_spelling);
      - one slip in a long name (Layer 3 only): the skeleton with any one
        letter dropped;
      - acronym (Layer 3 only): the name in capitals ("caps"), which meets
        the initials of a longer name ("init");
      - ticker (Layer 3 only): two to six capitals ("tick"), which meet the
        initials of a name's words without stopwords and the starts of its
        first word ("tock");
      - "Full Name (ABBR)": the same keys for the bracket and the full name;
      - people (person=True): each word, for surname and initial matches.
    A name that adds words to a page title is found by WordBagIndex
    instead (_extension_node_pairs).
    """
    keys = {("lower", name.lower())}
    skeleton = _skeleton(name)
    keys.update(("skel", f) for f in _singulars(skeleton) if f)
    tokens = _name_tokens(name)
    if len(tokens) >= 2:
        head = _skeleton(_word_key(tokens[-1]))
        keys.update(("head", f"{len(tokens)}:{f}") for f in _singulars(head) if f)
    if len(skeleton) >= 8:
        keys.update(("drop", skeleton[:k] + skeleton[k + 1:]) for k in range(len(skeleton)))
        keys.add(("drop", skeleton))
    caps, initials = [name.upper()], [_initials(name)]
    bracket = _split_parenthetical(name)
    if bracket is not None:
        base, inner = bracket
        keys.update(("skel", s) for s in (_skeleton(base), _skeleton(inner)) if s)
        caps.append(inner.upper())
        initials.append(_initials(base))
    keys.update(("caps", c) for c in caps if c)
    keys.update(("init", c) for c in initials if c)
    if is_ticker(name):
        keys.add(("tick", name.strip().lower()))
    ticker_initial = ticker_initials(name)
    keys.update(("tock", t) for t in ([ticker_initial] if ticker_initial else []) + ticker_prefixes(name))
    if person:
        keys.update(("token", t) for t in tokens)
    return keys


_PARTNER_KINDS = {"caps": "init", "init": "caps", "tick": "tock", "tock": "tick"}


def _partner_key(key: tuple[str, str]) -> tuple[str, str]:
    """The key a matching name carries: the same one, except that a name in
    capitals meets the initials of another and a ticker the start of
    another, and the other way round. Two long names with the same initials
    are never compared for it."""
    kind, value = key
    return (_PARTNER_KINDS.get(kind, kind), value)


def _title_key(name: str) -> str:
    """How a name meets an existing page title exactly: Unicode NFC, no
    surrounding spaces, any case ("OpenAI " is the page "OpenAI")."""
    return unicodedata.normalize("NFC", name).strip().lower()


def _alias_key(name: str) -> str:
    """How a name meets a stored alias when the lower case differs: the
    skeleton page titles use, read after British -our / -ise spellings
    are written the American way (routers/resolution_spelling.py):
    "Colour-blindness", "colour blindness" and "colorblindness" meet."""
    return _skeleton(us_spelling(unicodedata.normalize("NFKC", name)))


def _canonical_name(
    names: list[str],
    source_counts: dict[str, int] | None = None,
    person: bool = False,
) -> str:
    """Pick the canonical name of a merged group.

    People: the fullest name ("Andrej Karpathy" over "Karpathy"). Everything
    else: the name the most sources use, so one source's narrower phrase
    ("Bitcoin network") doesn't rename a topic most sources call "Bitcoin".
    Ties: longest, then capitalised, then alphabetical — a group of names
    used once each gets the longest, as before.
    """
    counts = source_counts or {}

    def key(name: str) -> tuple[int, int, int, str]:
        uses = counts.get(name, 0)
        lowercase_first = 0 if name[:1].isupper() else 1
        if person:
            return (-len(name), -uses, lowercase_first, name)
        return (-uses, -len(name), lowercase_first, name)

    return sorted(dict.fromkeys(names), key=key)[0]


def _source_counts(entities: list[EntityInput], members: list[int]) -> dict[str, int]:
    """Distinct sources per name within a group."""
    seen: dict[str, set[str]] = {}
    for i in members:
        seen.setdefault(entities[i].name, set()).add(entities[i].source_id)
    return {name: len(ids) for name, ids in seen.items()}


def _all_person(entities: list[EntityInput], members: list[int]) -> bool:
    return all(entities[i].type == "PERSON" for i in members)


class _GuardedUnion:
    """Union-Find with a complete-linkage veto: two groups join only when
    every name of one matches every name of the other, so a chain can't put
    "Python 2" and "Python 3", "Paul Graham" and "Paul Allen", or two
    different people who share a surname in one group. A group bound to an
    existing page (`anchors`) takes in only names that match that page, or
    a name bound to it, by the strict cross-session rules: "Paul Allen"
    joined the page "Paul" through an in-session "Paul" (audit 2026-10-23).
    Two groups bound to different pages never join."""

    def __init__(self, entities: list[EntityInput], anchors: dict[int, str] | None = None) -> None:
        self.entities = entities
        self.uf = _UnionFind(len(entities))
        self.members: dict[int, list[int]] = {i: [i] for i in range(len(entities))}
        self.anchor: dict[int, str | None] = {i: (anchors or {}).get(i) for i in range(len(entities))}
        self.methods: dict[int, set[str]] = {i: set() for i in range(len(entities))}
        self.bound = set(anchors or {})
        self._links: dict[tuple[int, int], bool] = {}

    def find(self, i: int) -> int:
        return self.uf.find(i)

    def linked(self, x: int, y: int) -> bool:
        """Two names Layer 1 would merge on their own."""
        key = (x, y) if x < y else (y, x)
        if key not in self._links:
            a, b = self.entities[x], self.entities[y]
            person = a.type == "PERSON" and b.type == "PERSON"
            self._links[key] = _types_compatible(a.type, b.type) and \
                _fuzzy_method(a.name, b.name, person_pair=person) is not None
        return self._links[key]

    def _matches_anchor(self, anchored: int, joining: int) -> bool:
        """Every name of the joining group matches the anchored group's page
        title, or a name bound to it, as _cross_session_method allows."""
        anchor = self.anchor[anchored]
        assert anchor is not None
        targets = {anchor, *(self.entities[k].name for k in self.members[anchored] if k in self.bound)}
        return all(
            any(_cross_session_method(e.name, t, person=e.type == "PERSON") for t in targets)
            for e in (self.entities[k] for k in self.members[joining])
        )

    def try_union(self, i: int, j: int, method: str) -> bool:
        ri, rj = self.find(i), self.find(j)
        if ri == rj:
            self.methods[ri].add(method)
            return True
        ai, aj = self.anchor[ri], self.anchor[rj]
        if ai is not None and aj is not None:
            # Both already resolve to an existing page: same page → same group.
            if ai != aj:
                return False
        elif ai is not None or aj is not None:
            anchored, joining = (ri, rj) if ai is not None else (rj, ri)
            if not self._matches_anchor(anchored, joining):
                return False
        elif not all(self.linked(x, y) for x in self.members[ri] for y in self.members[rj]):
            return False
        self.uf.union(ri, rj)
        root = self.find(ri)
        other = rj if root == ri else ri
        self.members[root] = self.members[ri] + self.members[rj] if root == ri else self.members[rj] + self.members[ri]
        self.anchor[root] = ai if ai is not None else aj
        self.methods[root] = self.methods[ri] | self.methods[rj] | {method}
        del self.members[other], self.anchor[other], self.methods[other]
        return True

    def groups(self) -> dict[int, list[int]]:
        return {root: sorted(members) for root, members in self.members.items()}


# ---------------------------------------------------------------------------
# POST /resolve/fuzzy
# ---------------------------------------------------------------------------


class ExistingAlias(BaseModel):
    model_config = ConfigDict(extra='forbid')
    alias: str
    canonical: str


class FuzzyResolveRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entities: list[EntityInput]
    existing_aliases: list[ExistingAlias] = []
    existing_page_titles: list[ExistingPageTitle] = []


class FuzzyResolveResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resolved: list[ResolvedGroup]
    unresolved: list[EntityInput]


@router.post("/resolve/fuzzy", response_model=FuzzyResolveResponse)
def resolve_fuzzy(req: FuzzyResolveRequest) -> FuzzyResolveResponse:
    """Layer 1 fuzzy resolution.

    Binds names that are existing page titles first, then existing aliases
    in any spelling (instant resolution for returning sessions), then
    near-spellings of page titles, then pairwise spelling criteria (exact,
    skeleton, plural,
    near-spelling, acronym, "Full Name (ABBR)", and for people
    surname/initial matches) grouped by a union that refuses to chain
    different versions, pages or people.
    """
    if not req.entities:
        return FuzzyResolveResponse(resolved=[], unresolved=[])

    # The input arrives in the order extractions finished and pages were
    # read, which changes between runs. Sorted, the same names always give
    # the same groups, canonicals and types ("Steiner" joined George or
    # Thomas Steiner by input order). Aliases keep their order: the newest
    # row for an alias wins.
    entities = sorted(req.entities, key=lambda e: (e.name, e.type, e.source_id, e.context))
    titles = sorted(req.existing_page_titles, key=lambda pt: (pt.title, pt.page_type))
    n = len(entities)

    # Stored aliases by exact lower case, then by spelling (_alias_key):
    # "colorblindness" is the alias "Colour-blindness". The newest row wins.
    alias_lookup: dict[str, str] = {
        ea.alias.lower(): ea.canonical for ea in req.existing_aliases
    }
    alias_spellings: dict[str, ExistingAlias] = {
        key: ea for ea in req.existing_aliases if (key := _alias_key(ea.alias))
    }

    # Track which entities were resolved via existing alias or existing page title.
    # Both bind an entity to an already-known canonical without further fuzzy work.
    alias_canonical: dict[int, str] = {}
    alias_method: dict[int, str] = {}  # "existing_alias" | "existing_page_title"

    # A name that IS an existing page's title binds to that page first: ahead
    # of any alias, and whatever kind the page is. Sources disagree on kind
    # ("APCA" is PRODUCT in one, CONCEPT in the next) and plan's title lookup
    # updates that page anyway, so a kind check here only let the in-session
    # LLM rename the name ("APCA" → "APCA contrast algorithm"). The alias row
    # that left behind then sent every later "APCA" to a duplicate page
    # (2026-10-17, session e55c740b, then 5f009864).
    page_title_lookup: dict[str, ExistingPageTitle] = {_title_key(pt.title): pt for pt in titles}
    for i, e in enumerate(entities):
        pt_exact = page_title_lookup.get(_title_key(e.name))
        if pt_exact:
            alias_canonical[i] = pt_exact.title
            alias_method[i] = "existing_page_title"

    for i, e in enumerate(entities):
        if i in alias_canonical:
            continue
        canon = alias_lookup.get(e.name.lower())
        if not canon:
            spelt = alias_spellings.get(_alias_key(e.name))
            if spelt is not None and not _numeric_conflict(e.name, spelt.alias):
                canon = spelt.canonical
        if canon:
            alias_canonical[i] = canon
            alias_method[i] = "existing_alias"

    # Cross-session anchor: match the remaining unbound entities against
    # existing wiki page titles by spelling. Page-type gates entity-type
    # compatibility (entity page ↔ non-concept types; concept page ↔ CONCEPT/OTHER),
    # except for a capitalised acronym and its expansion, which bind whatever
    # kind each side has. Only the titles sharing a blocking key with the
    # name are looked at, in title order.
    titles_by_key: dict[tuple[str, str], list[int]] = {}
    for k, pt in enumerate(titles):
        for key in _block_keys(pt.title):
            titles_by_key.setdefault(key, []).append(k)
    for i, e in enumerate(entities):
        if i in alias_canonical:
            continue
        near = [titles[k] for k in sorted(
            {k for key in _block_keys(e.name) for k in titles_by_key.get(_partner_key(key), ())}
        )]
        # Fuzzy match against any page title — uses the strict cross-session
        # matcher (no substring) to avoid binding short-name entities to
        # longer-name pages they happen to be a character-level prefix of
        # (e.g. "Vilnius" ↔ existing "Vilnius Cathedral"). Layer 2 embedding
        # handles those semantically.
        page = next(
            (pt for pt in near
             if _entity_matches_page_type(e.type, pt.page_type)
             and _cross_session_method(e.name, pt.title, person=e.type == "PERSON")),
            None,
        ) or next((pt for pt in near if _cross_kind_acronym(e.name, pt.title)), None)
        if page:
            alias_canonical[i] = page.title
            alias_method[i] = "existing_page_title"

    guard = _GuardedUnion(entities, alias_canonical)
    for i, method in alias_method.items():
        guard.methods[i].add(method)

    # Group entities that share the same existing canonical
    canon_to_indices: dict[str, list[int]] = {}
    for i, canon in alias_canonical.items():
        canon_to_indices.setdefault(canon, []).append(i)
    for canon, indices in canon_to_indices.items():
        for j in indices[1:]:
            guard.try_union(indices[0], j, alias_method.get(indices[0], "existing_alias"))

    # Pairwise fuzzy matching over the pairs that share a blocking key. A
    # name that matches two names which do not match each other (a hub:
    # "Paul" between "Paul Graham" and "Paul Allen") joins neither, so the
    # groups do not depend on which pair comes first; its exact duplicates
    # still join it. Pairs touching a page go first, then (i, j) order, and
    # the guard refuses any union that is not complete linkage.
    keys = [_block_keys(e.name, person=e.type == "PERSON") for e in entities]
    by_key: dict[tuple[str, str], list[int]] = {}
    for i, own in enumerate(keys):
        for key in own:
            by_key.setdefault(key, []).append(i)
    links: dict[int, dict[int, str]] = {i: {} for i in range(n)}
    for i in range(n):
        partners = {j for key in keys[i] for j in by_key.get(_partner_key(key), ()) if j > i}
        for j in sorted(partners):
            if not _types_compatible(entities[i].type, entities[j].type):
                continue
            person_pair = entities[i].type == "PERSON" and entities[j].type == "PERSON"
            method = _fuzzy_method(entities[i].name, entities[j].name, person_pair=person_pair)
            if method:
                links[i][j] = links[j][i] = method

    def linked(j: int, k: int) -> bool:
        aj, ak = alias_canonical.get(j), alias_canonical.get(k)
        if aj is not None and ak is not None:
            return aj == ak
        return k in links[j]

    hub = hubs({i: sorted(j for j, m in links[i].items() if m != "exact") for i in range(n)}, linked)
    edges = sorted(
        ((i, j, m) for i in range(n) for j, m in links[i].items()
         if i < j and (m == "exact" or not ({i, j} & hub))),
        key=lambda e: (e[0] not in alias_canonical and e[1] not in alias_canonical, e[0], e[1]),
    )
    for i, j, method in edges:
        if guard.find(i) != guard.find(j):
            guard.try_union(i, j, method)

    resolved: list[ResolvedGroup] = []
    unresolved: list[EntityInput] = []

    for root, members in sorted(guard.groups().items(), key=lambda kv: kv[1][0]):
        if len(members) == 1:
            # Check if this single entity was matched via existing alias or page title
            idx = members[0]
            if idx in alias_canonical:
                # Still emit as resolved (canonical from alias table or existing page)
                # The name itself is an alias only when it differs from the
                # canonical: "APCA" bound to the page "APCA" is no alias row.
                resolved.append(ResolvedGroup(
                    canonical=alias_canonical[idx],
                    type=entities[idx].type,
                    aliases=[entities[idx].name] if entities[idx].name != alias_canonical[idx] else [],
                    source_ids=[entities[idx].source_id],
                    method=alias_method.get(idx, "existing_alias"),
                ))
            else:
                unresolved.append(entities[idx])
            continue

        names = [entities[i].name for i in members]
        source_ids = list(dict.fromkeys(entities[i].source_id for i in members))  # deduplicated, ordered

        # Determine canonical: prefer existing alias/page-title canonical if
        # available, else the name most sources use (people: the fullest name)
        canon_from_alias = next(
            (alias_canonical[i] for i in members if i in alias_canonical), None
        )
        canon = canon_from_alias or _canonical_name(
            names, _source_counts(entities, members), _all_person(entities, members)
        )

        aliases = [n for n in names if n != canon]

        # Best method = most specific one used in THIS group. Page-title
        # binding takes precedence over same-session fuzzy signals because
        # it's authoritative (the target already exists in the wiki).
        method_priority = [
            "existing_page_title", "existing_alias", "exact", "skeleton", "plural", "levenshtein", "jaro_winkler",
            "person_subset", "person_initials", "parenthetical",
        ]
        used_methods = guard.methods[root]
        best_method = next((m for m in method_priority if m in used_methods), "fuzzy")

        resolved.append(ResolvedGroup(
            canonical=canon,
            # The kind most of its names carry, not the first one's: input
            # order decided between a concept page and an entity page.
            type=majority_kind((entities[i].type, 1) for i in members),
            aliases=aliases,
            source_ids=source_ids,
            method=best_method,
        ))

    return FuzzyResolveResponse(resolved=resolved, unresolved=unresolved)


# ---------------------------------------------------------------------------
# POST /resolve/embedding
# ---------------------------------------------------------------------------


class AmbiguousPair(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entity_a: EntityInput
    entity_b: EntityInput
    similarity: float
    # Cosine of the names alone. Pairs are ranked by it, so a pair that is
    # alike only in context never takes a Layer 3 slot from one whose names
    # are alike (see resolve_embedding). /resolve/disambiguate does not need it.
    name_similarity: float = 0.0
    # One source names both sides. Layer 3 reads it as a hint: such a source
    # usually tells two things apart, but it can also give one thing's full
    # name and its abbreviation. Optional, so older callers still validate.
    same_source: bool = False
    # One side's names hold an acronym of the other's ("ML" / "Machine
    # Learning"). Layer 1 no longer merges these; the pair is asked whatever
    # its similarity and ranks with the abbreviations (_layer3_rank).
    abbreviation: bool = False
    # Asked only because the two are among each other's closest by meaning
    # (_MEANING_CANDIDATES): ranked after the pairs whose names are alike in
    # its tier, by `similarity`, the meaning cosine.
    by_meaning: bool = False


class GroupInput(BaseModel):
    """A Layer 1 group handed on to Layer 2, so a name Layer 1 grouped or
    bound to a page is still compared with the rest of the session. Without
    it "APCA", bound to its page in Layer 1, never met "APCA contrast
    algorithm", and "Contrast ratio" (two sources) never met "Colour contrast
    ratio" (2026-10-17, sessions e55c740b and 61c8bb37)."""
    model_config = ConfigDict(extra='forbid')
    canonical: str
    type: str
    aliases: list[str]
    source_ids: list[str]
    method: str
    context: str = ""


class EmbeddingResolveRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entities: list[EntityInput]
    existing_page_titles: list[ExistingPageTitle] = []
    groups: list[GroupInput] = []


class EmbeddingResolveResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resolved: list[ResolvedGroup]
    ambiguous: list[AmbiguousPair]
    unresolved: list[EntityInput]
    # Pairs (and page anchors) similar enough to merge that went to Layer 3
    # instead, because their content words differ or a side has no context.
    rerouted: int = 0


# Sentinel source_id for synthetic EntityInput representing an existing wiki page
# title in an AmbiguousPair. The Next.js consumer recognises this value and
# handles it differently from real session sources when Layer 3 returns a decision.
EXISTING_PAGE_SENTINEL = "__existing_page__"

# Source_id prefix for a group in an AmbiguousPair: "__group__:<k>" is
# resolved[k] of the same response. The Next.js consumer folds a Layer 3
# 'same' verdict into that group. Mirrored in
# app/src/app/api/compile/resolve/route.ts.
GROUP_SENTINEL_PREFIX = "__group__:"

# Layer 1 methods that bind a group to a known canonical (a page title or a
# stored alias): such a group is anchored.
_ANCHORED_METHODS = frozenset({"existing_page_title", "existing_alias"})

# Layer 2 cosine bands: above MERGE same, below AMBIGUOUS different, between
# them Layer 3 decides.
_MERGE_SIMILARITY = 0.9
_AMBIGUOUS_SIMILARITY = 0.7
# A name against a page of the other kind may reach the ambiguous band on
# "name: context" similarity only with at least this name similarity
# (resolve_embedding): "Colorblindness" / "Color Vision Deficiency (CVD)"
# 0.68 is asked, "Color Oracle" / "Color blindness simulation" 0.45 is not.
_CROSS_KIND_CONTEXT_MIN_NAME_SIMILARITY = 0.6
# Closest by meaning (owner decision 2026-10-25): each name is also asked
# about its few nearest other names and pages by "name: context" against
# "name: context" or "title: summary", whatever the names look like. The
# filters above let 55 of 100 held-out same-thing pairs (Wikidata) go
# unasked ("Colorblindness" / "Color Vision Deficiency"), while Layer 3 got
# every pair it saw right. Meaning cannot tell such pairs apart by itself
# (SARS-CoV / SARS-CoV-2 0.78, mpox / Monkeypox 0.69), so it only nominates
# and Layer 3 decides, after the name-alike pairs (_layer3_rank).
_MEANING_CANDIDATES = 3
_MEANING_MIN_SIMILARITY = 0.6

# A concept and a named thing can be one topic ("UNESCO World Heritage" /
# "UNESCO World Heritage list"), so Layer 2 compares them; only Layer 3 may
# merge them.
_NAMED_KINDS = frozenset({"PERSON", "ORG", "PRODUCT", "LOCATION", "EVENT"})


def _page_type_to_entity_type(page_type: str) -> str:
    """Map pages.page_type to a representative entity type for synthetic pairs."""
    if page_type == "concept":
        return "CONCEPT"
    return "OTHER"


def _kinds_cross(t1: str, t2: str) -> bool:
    return (t1 == "CONCEPT" and t2 in _NAMED_KINDS) or (t2 == "CONCEPT" and t1 in _NAMED_KINDS)


def _page_kinds_cross(entity_type: str, page_type: str) -> bool:
    if page_type == "concept":
        return entity_type in _NAMED_KINDS
    if page_type == "entity":
        return entity_type == "CONCEPT"
    return False


def _version_clash(a: str, b: str) -> bool:
    """Different numbers on names that share a word: two versions ("Python 2"
    / "Python 3", "GPT-4" / "GPT-4o"), never one thing. Names with no word
    in common may be a rename that changed a number ("2019-nCoV" /
    "SARS-CoV-2", "COP21" / "2015 United Nations Climate Change
    Conference"); Layer 3 judges those when they are closest by meaning."""
    if _numeric_conflict(a, b) != "hard":
        return False
    words = lambda s: {w for w in re.findall(r"[a-z]+", s.lower()) if len(w) > 1}  # noqa: E731
    return bool(words(a) & words(b))


def _names_guard(names_a: list[str], names_b: list[str]) -> str | None:
    """"hard" when two of the names carry different numbers (never the same
    thing); "soft" when a number only one carries or extra words could still
    make them two things (never merged on similarity alone); else None."""
    worst: str | None = None
    for x in names_a:
        for y in names_b:
            conflict = _numeric_conflict(x, y)
            if conflict == "hard":
                return "hard"
            if conflict or _is_token_extension(x, y):
                worst = "soft"
    return worst


def _layer3_rank(pair: AmbiguousPair, one_source: bool) -> tuple[bool, bool, bool, float, float]:
    """Sort key for Layer 3's capped budget (DISAMBIGUATE_MAX_PAIRS); the
    route ranks the same way (app/src/lib/resolve-ranking.ts). Tiers first:
    a pair against the wiki (a page, or a group bound to one) or across
    sources before a pair whose two sides one source names. A list article
    ("Kaunas Castle / Cathedral / Town Hall / Fortress ...") gives many of
    those, usually different things, and they used to push out the rest.
    Within a tier an abbreviation and its long form first, since their
    names score low ("ETH" / "Ethereum"), also when the acronym is another
    name of a group (`abbreviation`); then name similarity, so a pair
    alike only in context ("Set collection" / "Route planning", 0.98 by
    context, 0.10 by name) never buys a slot; then similarity. Pairs asked
    only because they are closest by meaning (`by_meaning`) come after the
    rest of their tier, most alike in meaning first."""
    if pair.by_meaning:
        return (one_source, True, True, -pair.similarity, -pair.name_similarity)
    a, b = pair.entity_a.name, pair.entity_b.name
    abbreviation = pair.abbreviation or _is_abbreviation(a, b) or _is_abbreviation(b, a)
    return (one_source, False, not abbreviation, -pair.name_similarity, -pair.similarity)


def _layer3_only_kind(names_a: list[str], type_a: str, names_b: list[str], type_b: str) -> str | None:
    """_layer3_only_method between two nodes: "acronym" when any name of
    one is an acronym of a name of the other and the kinds may meet in
    Layer 2 (a concept and a named thing included), else "slip" for a
    one-letter slip between kinds that may merge, else None."""
    person = type_a == "PERSON" and type_b == "PERSON"
    kinds = {_layer3_only_method(x, y, person=person) for x in names_a for y in names_b}
    if "acronym" in kinds and (_types_compatible(type_a, type_b) or _kinds_cross(type_a, type_b)):
        return "acronym"
    if "slip" in kinds and _types_compatible(type_a, type_b):
        return "slip"
    return None


def _layer3_only_page_kind(names: list[str], type_: str, page: ExistingPageTitle) -> str | None:
    """_layer3_only_method between a node and a page title: an acronym
    whatever the kinds (sources type "WCAG" ORG and the guidelines CONCEPT),
    a one-letter slip only against a page of the node's kind."""
    kinds = {_layer3_only_method(x, page.title, person=type_ == "PERSON") for x in names}
    if "acronym" in kinds:
        return "acronym"
    if "slip" in kinds and _entity_matches_page_type(type_, page.page_type):
        return "slip"
    return None


@dataclass
class _Node:
    """What Layer 2 compares: a group passed in, or a lone entity."""
    name: str                     # the group's canonical, or the entity's name
    type: str
    context: str
    names: list[str]              # every name it stands for
    source_ids: list[str]
    anchor: str | None = None     # the page title / alias canonical it is bound to
    group: GroupInput | None = None
    entity: EntityInput | None = None

    @property
    def text(self) -> str:
        return f"{self.name}: {self.context}" if self.context else self.name

    @property
    def bound_in_layer1(self) -> bool:
        return self.group is not None and self.group.method in _ANCHORED_METHODS


class _NodeUnion:
    """Union-Find over Layer 2 nodes. Nodes bound to the same page always
    join; nodes bound to different pages never do. Otherwise a merge is
    refused when the two sides share a source (a source that names both is
    telling them apart: "Kaunas City Hall" / "Kaunas City Museum"), when any
    of their names carry different numbers or extend one another, or when
    they are two different people."""

    def __init__(self, nodes: list[_Node]) -> None:
        self.nodes = nodes
        self.uf = _UnionFind(len(nodes))
        self.members: dict[int, list[int]] = {i: [i] for i in range(len(nodes))}
        self.anchor: dict[int, str | None] = {i: nd.anchor for i, nd in enumerate(nodes)}

    def find(self, i: int) -> int:
        return self.uf.find(i)

    def try_union(self, i: int, j: int) -> bool:
        ri, rj = self.find(i), self.find(j)
        if ri == rj:
            return True
        ai, aj = self.anchor[ri], self.anchor[rj]
        if ai is not None and aj is not None:
            if ai.lower() != aj.lower():
                return False
        else:
            mi, mj = self.members[ri], self.members[rj]
            if {s for k in mi for s in self.nodes[k].source_ids} & {s for k in mj for s in self.nodes[k].source_ids}:
                return False
            names_i = [x for k in mi for x in self.nodes[k].names]
            names_j = [x for k in mj for x in self.nodes[k].names]
            if _names_guard(names_i, names_j) is not None:
                return False
            if all(self.nodes[k].type == "PERSON" for k in mi + mj) and \
                    any(_person_names_clash(x, y) for x in names_i for y in names_j):
                return False
        self.uf.union(ri, rj)
        root = self.find(ri)
        other = rj if root == ri else ri
        self.members[root] = sorted(self.members[ri] + self.members[rj])
        self.anchor[root] = ai if ai is not None else aj
        del self.members[other], self.anchor[other]
        return True


def _final_group(nodes: list[_Node], members: list[int], anchor: str | None) -> tuple[ResolvedGroup, str]:
    """The ResolvedGroup a set of merged nodes becomes, and the context that
    speaks for it in a pair. A group passed in that nothing joined comes back
    unchanged. Otherwise the group bound to a page leads, then the group most
    sources back: its canonical stays, so one more name never renames a topic
    the sources already agree on."""
    picked = [nodes[k] for k in members]
    groups = [nd for nd in picked if nd.group is not None]
    if len(picked) == 1 and groups and (anchor is None or groups[0].bound_in_layer1):
        g = groups[0].group
        assert g is not None
        return ResolvedGroup(
            canonical=g.canonical, type=g.type, aliases=list(g.aliases),
            source_ids=list(g.source_ids), method=g.method,
        ), g.context

    bound = [nd for nd in groups if nd.anchor is not None]
    by_support = sorted(groups, key=lambda nd: -len(nd.source_ids))
    lead = (bound or by_support or picked)[0]
    if anchor is not None:
        canonical = anchor
        method = lead.group.method if lead.group is not None and lead.bound_in_layer1 else "existing_page_title"
    elif lead.group is not None:
        canonical, method = lead.name, "embedding"
    else:
        ents = [nd.entity for nd in picked if nd.entity is not None]
        idx = list(range(len(ents)))
        canonical = _canonical_name([e.name for e in ents], _source_counts(ents, idx), _all_person(ents, idx))
        method = "embedding"

    ordered = [lead] + [nd for nd in picked if nd is not lead]
    aliases = [x for x in dict.fromkeys(x for nd in ordered for x in nd.names) if x != canonical]
    source_ids = list(dict.fromkeys(s for nd in ordered for s in nd.source_ids))
    context = next((nd.context for nd in ordered if nd.context), "")
    kind = majority_kind((nd.type, max(1, len(nd.source_ids))) for nd in picked)  # the kind most sources give
    return ResolvedGroup(
        canonical=canonical, type=kind, aliases=aliases, source_ids=source_ids, method=method,
    ), context


def _extensions(names: list[str], index: WordBagIndex, titles: list[str]) -> list[int]:
    """The titles (indexed in `index`) that one of `names` adds words to,
    numbers alike, in index order: "APCA contrast algorithm" / "APCA". A
    number only one name carries reads as a version ("Python 3 release" /
    "Python"): left to similarity, like the acronym pairs."""
    return sorted({k for x in names for k in index.contained_in(_name_tokens(x))
                   if not _numeric_conflict(x, titles[k])})


def _extension_node_pairs(nodes: list[_Node]) -> list[tuple[int, int]]:
    """Node pairs whose unanchored side has a name that adds words to the
    page title, or stored alias's canonical, the other side is bound to:
    "APCA contrast algorithm" against the group bound to the page "APCA".
    Its names score low against so short a title (0.53 by name, 0.57 with
    contexts: replay gate, 2026-10-23), so the pair is asked about whatever
    its similarity, for kinds that meet in Layer 2. Never merged without
    Layer 3: the same shape took "Ethereum" into "Ethereum Foundation" and
    "LLM" into "LLM draft path"."""
    bound = [(k, nd.anchor) for k, nd in enumerate(nodes) if nd.anchor is not None]
    anchors = [anchor for _k, anchor in bound]
    index = WordBagIndex([_name_tokens(t) for t in anchors])
    out: list[tuple[int, int]] = []
    for i, nd in enumerate(nodes):
        if nd.anchor is not None:
            continue
        for m in _extensions(nd.names, index, anchors):
            k = bound[m][0]
            if _types_compatible(nd.type, nodes[k].type) or _kinds_cross(nd.type, nodes[k].type):
                out.append((min(i, k), max(i, k)))
    return out


def _forced_node_pairs(nodes: list[_Node]) -> dict[tuple[int, int], str]:
    """Node pairs Layer 3 is asked about whatever their similarity, in node
    order: acronyms and slips (see _layer3_only_kind), found through the
    blocking keys, and names that add words to a page another node is bound
    to ("extension", _extension_node_pairs). Two nodes bound to pages are
    left out: two pages never meet."""
    keys = [set().union(*(_block_keys(x) for x in nd.names)) for nd in nodes]
    by_key: dict[tuple[str, str], list[int]] = {}
    for i, own in enumerate(keys):
        for key in own:
            by_key.setdefault(key, []).append(i)
    out: dict[tuple[int, int], str] = {}
    for i, a in enumerate(nodes):
        for j in sorted({j for key in keys[i] for j in by_key.get(_partner_key(key), ()) if j > i}):
            b = nodes[j]
            if a.anchor is not None and b.anchor is not None:
                continue
            kind = _layer3_only_kind(a.names, a.type, b.names, b.type)
            if kind is not None:
                out[(i, j)] = kind
    for key in _extension_node_pairs(nodes):
        out.setdefault(key, "extension")
    return dict(sorted(out.items()))


def _forced_page_pairs(nodes: list[_Node], pages: list[ExistingPageTitle]) -> list[tuple[int, int, str]]:
    """(node, page, kind) for each unanchored node and page title Layer 3 is
    asked about whatever their similarity: an acronym or slip (see
    _layer3_only_page_kind), "CI" against both "Continuous Integration" and
    "Confidence Interval"; and a name that adds words to the title
    ("extension": "APCA contrast algorithm" / "APCA", see
    _extension_node_pairs)."""
    titles_by_key: dict[tuple[str, str], list[int]] = {}
    for k, pt in enumerate(pages):
        for key in _block_keys(pt.title):
            titles_by_key.setdefault(key, []).append(k)
    titles = [pt.title for pt in pages]
    index = WordBagIndex([_name_tokens(t) for t in titles])
    out: list[tuple[int, int, str]] = []
    for i, nd in enumerate(nodes):
        if nd.anchor is not None:
            continue
        forced: dict[int, str] = {}
        near = {k for x in nd.names for key in _block_keys(x) for k in titles_by_key.get(_partner_key(key), ())}
        for k in sorted(near):
            kind = _layer3_only_page_kind(nd.names, nd.type, pages[k])
            if kind is not None:
                forced[k] = kind
        for k in _extensions(nd.names, index, titles):
            if _entity_matches_page_type(nd.type, pages[k].page_type) or _page_kinds_cross(nd.type, pages[k].page_type):
                forced.setdefault(k, "extension")
        out.extend((i, k, kind) for k, kind in sorted(forced.items()))
    return out


def _same_words_with_context(a: _Node, names_b: list[str], context_b: str | None, type_b: str) -> bool:
    """What a Layer 2 auto-merge needs besides similarity: both sides carry
    a context (without one, "name: context" is the name again and the two
    signals are one), and the names say the same content words
    (routers/resolution_rules.py). A page title has no context of its own
    (`context_b` None); the node's context still has to be there."""
    if not a.context.strip() or (context_b is not None and not context_b.strip()):
        return False
    return content_words_agree(a.names, names_b, person=a.type == "PERSON" and type_b == "PERSON")


@router.post("/resolve/embedding", response_model=EmbeddingResolveResponse)
def resolve_embedding(req: EmbeddingResolveRequest) -> EmbeddingResolveResponse:
    """Layer 2 embedding similarity resolution.

    Compares the lone entities and the Layer 1 groups (`groups`) with one
    another by the cosine similarity of the name alone and of "name:
    context". Context makes different things named in one source look alike
    ("Set collection" / "Route planning" score 0.98 with context, 0.10 by
    name; "English" / "programming language" 0.92 and 0.42 — 2026-10-10,
    sessions demo-p2 and demo-p1), so:

      - merge: both similarities > 0.9, same or compatible kinds, no source
        in common, no difference in numbers or extra words, both sides with
        a context, and names that say the same content words ("Zurich" /
        "Zürich"). Similarity alone merged "North Korea" / "South Korea"
        shaped pairs (audit 2026-10-23); a pair that passes everything but
        the last two goes to Layer 3 and is counted in `rerouted`;
      - ambiguous (Layer 3): otherwise, when either similarity is ≥ 0.7; a
        CONCEPT against ORG/PRODUCT/PERSON/LOCATION/EVENT when the names
        alone are, and against a page of the other kind when either is
        and the names score at least 0.6 (a page title is compared without a bracket that abbreviates
        it, _title_for_similarity); and, whatever the similarity, an acronym or ticker and
        its expansion or a one-letter slip (_layer3_only_method), which
        Layer 1 no longer merges, and a name that adds words to a page
        title or a stored alias's canonical, against that page
        (_extension_node_pairs); and each name's few closest other names
        and pages by meaning ("title: summary" for a page), `by_meaning`
        (_MEANING_CANDIDATES);
      - different: the rest, and two people who share only a surname.

    Cross-session: an unanchored node whose best page title passes the merge
    test (kinds must match; the node needs a context) is anchored to it,
    method 'existing_page_title'; a borderline page comes back as an
    AmbiguousPair whose entity_b carries EXISTING_PAGE_SENTINEL, and so
    does every page an acronym could stand for. Groups Layer 1 anchored
    (existing_page_title or existing_alias) are not compared with page
    titles again, and two nodes anchored to different pages are never
    merged or paired.

    `resolved` holds the final state of every group passed in (unchanged if
    nothing joined it), followed by the groups Layer 2 formed. A group in an
    AmbiguousPair carries source_id GROUP_SENTINEL_PREFIX + its index in
    `resolved`. Ambiguous pairs come ranked for Layer 3's capped budget
    (_layer3_rank): pairs against the wiki or across sources before pairs
    one source names both sides of; within each, abbreviations first, then
    name similarity, then similarity. Context likeness alone, the signal
    behind the wrong merges, never buys a slot. Each pair says whether one
    source names both sides (`same_source`) and whether it is an acronym
    pair (`abbreviation`).
    """
    import numpy as np
    from sklearn.metrics.pairwise import cosine_similarity as sklearn_cosine

    if not req.entities and not req.groups:
        return EmbeddingResolveResponse(resolved=[], ambiguous=[], unresolved=[])

    nodes: list[_Node] = [
        _Node(
            name=g.canonical, type=g.type, context=g.context,
            names=list(dict.fromkeys([g.canonical, *g.aliases])), source_ids=list(g.source_ids),
            anchor=g.canonical if g.method in _ANCHORED_METHODS else None, group=g,
        )
        for g in req.groups
    ] + [
        _Node(name=e.name, type=e.type, context=e.context, names=[e.name], source_ids=[e.source_id], entity=e)
        for e in req.entities
    ]

    # A page the session already holds as an anchored group is compared
    # through that group, which carries the session's context and sources.
    held = {nd.anchor.lower() for nd in nodes if nd.anchor is not None}
    pages = [pt for pt in req.existing_page_titles if pt.title.lower() not in held]

    model = _get_embed_model()
    page_texts = [_title_for_similarity(pt.title) for pt in pages]
    page_meanings = [f"{t}: {pt.summary}" if pt.summary else t for t, pt in zip(page_texts, pages)]
    texts = list(dict.fromkeys([nd.name for nd in nodes] + [nd.text for nd in nodes] + page_texts + page_meanings))
    vectors = model.encode(texts, convert_to_numpy=True)
    row = {t: k for k, t in enumerate(texts)}
    name_vecs = vectors[[row[nd.name] for nd in nodes]]
    ctx_vecs = vectors[[row[nd.text] for nd in nodes]]

    # Cross-session: compare each unanchored node with the existing page
    # titles; the page asked about is the one whose title is most like the name.
    page_pairs: list[tuple[float, float, int, ExistingPageTitle]] = []  # (name sim, sim, node, page)
    rerouted = 0
    name_page: Any = None
    ctx_page: Any = None
    if pages:
        page_vecs = vectors[[row[t] for t in page_texts]]
        name_page = sklearn_cosine(name_vecs, page_vecs)
        ctx_page = sklearn_cosine(ctx_vecs, page_vecs)
        for i, nd in enumerate(nodes):
            if nd.anchor is not None:
                continue
            anchor_to: tuple[float, ExistingPageTitle] | None = None
            ask_about: tuple[float, float, ExistingPageTitle] | None = None
            refused = False
            for j, pt in enumerate(pages):
                same_kind = _entity_matches_page_type(nd.type, pt.page_type)
                if not same_kind and not _page_kinds_cross(nd.type, pt.page_type):
                    continue
                ns, cs = float(name_page[i][j]), float(ctx_page[i][j])
                # Across kinds the context may ask too, never merge: a page
                # title carries no context from the node's source, unlike
                # two names one article describes alike (session pairs below).
                # "Colorblindness" / the entity page "Color Vision
                # Deficiency (CVD)" scored 0.68 by name, 0.77 with context.
                # Only names alike enough may ask on context, so a person or
                # a tool its article ties to a concept page ("Francis Wolff"
                # / "Candid photography", 0.2 by name) takes no Layer 3 slot.
                cross_floor = not same_kind and ns < _CROSS_KIND_CONTEXT_MIN_NAME_SIMILARITY
                sim = ns if cross_floor else max(ns, cs)
                if sim < _AMBIGUOUS_SIMILARITY:
                    continue
                guard = _names_guard(nd.names, [pt.title])
                if guard == "hard":
                    continue  # a page for a different version is never the same topic
                similar = same_kind and guard is None and min(ns, cs) > _MERGE_SIMILARITY
                if similar and _same_words_with_context(nd, [pt.title], None, nd.type):
                    if anchor_to is None or min(ns, cs) > anchor_to[0]:
                        anchor_to = (min(ns, cs), pt)
                else:
                    refused = refused or similar
                    if ask_about is None or (ns, sim) > ask_about[:2]:
                        ask_about = (ns, sim, pt)
            if anchor_to is not None:
                nd.anchor = anchor_to[1].title
            else:
                rerouted += refused
                if ask_about is not None:
                    page_pairs.append((ask_about[0], ask_about[1], i, ask_about[2]))

    union = _NodeUnion(nodes)
    first_on_page: dict[str, int] = {}
    for i, nd in enumerate(nodes):
        if nd.anchor is not None:
            union.try_union(first_on_page.setdefault(nd.anchor.lower(), i), i)

    # Session-internal comparison. Only pairs with a similarity in reach are
    # looked at; a pair that may merge is merged strongest first, so a node
    # joins the group it is most like.
    name_sim: Any = sklearn_cosine(name_vecs)
    ctx_sim: Any = sklearn_cosine(ctx_vecs)
    in_reach = np.triu(np.maximum(name_sim, ctx_sim) >= _AMBIGUOUS_SIMILARITY, k=1)
    merges: list[tuple[float, float, float, int, int]] = []  # (merge score, sim, name sim, i, j)
    pairs: list[tuple[float, float, int, int]] = []          # (sim, name sim, i, j)
    for i, j in zip(*np.nonzero(in_reach)):
        i, j = int(i), int(j)
        a, b = nodes[i], nodes[j]
        if a.anchor is not None and b.anchor is not None:
            continue  # bound already: one page joined above, two pages never meet
        same_kind = _types_compatible(a.type, b.type)
        if not same_kind and not _kinds_cross(a.type, b.type):
            continue
        ns, cs = float(name_sim[i][j]), float(ctx_sim[i][j])
        if not same_kind and ns < _AMBIGUOUS_SIMILARITY:
            # Across kinds only the names can say two things are one topic;
            # one article's context makes its person and its subject alike
            # ("Francis Wolff" / "Candid photography" 0.86 — 2026-10-17,
            # session 61c8bb37).
            continue
        guard = _names_guard(a.names, b.names)
        if guard == "hard":
            continue  # different versions ("GPT-4" / "GPT-4o" scores 0.90)
        if a.type == "PERSON" and b.type == "PERSON" and \
                any(_person_names_clash(x, y) for x in a.names for y in b.names):
            continue  # two people who share a surname ("George Steiner" / "Thomas Steiner")
        similar = same_kind and guard is None and min(ns, cs) > _MERGE_SIMILARITY \
            and not set(a.source_ids) & set(b.source_ids)
        if similar and _same_words_with_context(a, b.names, b.context, b.type):
            merges.append((min(ns, cs), max(ns, cs), ns, i, j))
        else:
            rerouted += similar
            pairs.append((max(ns, cs) if same_kind else ns, ns, i, j))
    for _score, sim, ns, i, j in sorted(merges, key=lambda m: (-m[0], m[3], m[4])):
        if not union.try_union(i, j):
            pairs.append((sim, ns, i, j))  # refused for what its group already holds: Layer 3 decides

    # Emit: every group passed in and every group formed here, in input order.
    resolved: list[ResolvedGroup] = []
    slot: dict[int, int] = {}            # union root → index in resolved
    context: dict[int, str] = {}
    for root, members in sorted(union.members.items(), key=lambda kv: kv[1][0]):
        lone_entity = len(members) == 1 and nodes[members[0]].group is None and union.anchor[root] is None
        if lone_entity:
            continue
        group, context[root] = _final_group(nodes, members, union.anchor[root])
        slot[root] = len(resolved)
        resolved.append(group)

    def ref(root: int) -> EntityInput:
        if root in slot:
            g = resolved[slot[root]]
            return EntityInput(name=g.canonical, type=g.type, source_id=f"{GROUP_SENTINEL_PREFIX}{slot[root]}",
                               context=context[root])
        entity = nodes[root].entity
        assert entity is not None
        return entity

    # Pairs between what the nodes became; per two groups the strongest
    # similarity and the strongest name similarity.
    best: dict[tuple[int, int], tuple[float, float]] = {}

    def note(key: tuple[int, int], sim: float, ns: float) -> None:
        old = best.get(key)
        best[key] = (sim, ns) if old is None else (max(old[0], sim), max(old[1], ns))

    def key_of(ra: int, rb: int) -> tuple[int, int]:
        return (ra, rb) if union.members[ra][0] < union.members[rb][0] else (rb, ra)

    for sim, ns, i, j in pairs:
        ri, rj = union.find(i), union.find(j)
        if ri == rj or (union.anchor[ri] is not None and union.anchor[rj] is not None):
            continue
        note(key_of(ri, rj), sim, ns)
    on_page = {anchor.lower(): root for root, anchor in union.anchor.items() if anchor is not None}
    # Page pairs: root, page title (lower case) → (name sim, sim, page, abbreviation).
    page_asks: dict[tuple[int, str], tuple[float, float, ExistingPageTitle, bool]] = {}
    page_best: dict[int, tuple[float, float, ExistingPageTitle]] = {}  # root → (name sim, sim, page)
    for ns, sim, i, pt in page_pairs:
        root = union.find(i)
        if union.anchor[root] is not None:
            continue  # anchored after all: not compared with pages again
        holder = on_page.get(pt.title.lower())
        if holder is not None:
            # Another node was anchored to that page here: ask about its group.
            note(key_of(root, holder), sim, ns)
        elif root not in page_best or (ns, sim) > page_best[root][:2]:
            page_best[root] = (ns, sim, pt)
    for root, (ns, sim, pt) in page_best.items():
        page_asks[(root, pt.title.lower())] = (ns, sim, pt, False)

    # Acronyms, one-letter slips and names that add words to a page title
    # are asked about whatever their similarity: Layer 1 no longer merges
    # them, and their names score low ("ML" / "Machine Learning", "APCA" /
    # "APCA contrast algorithm"), so a similarity band would drop them.
    acronym: set[tuple[int, int]] = set()
    for (i, j), kind in _forced_node_pairs(nodes).items():
        ri, rj = union.find(i), union.find(j)
        if ri == rj or (union.anchor[ri] is not None and union.anchor[rj] is not None):
            continue
        ns, cs = float(name_sim[i][j]), float(ctx_sim[i][j])
        note(key_of(ri, rj), max(ns, cs) if _types_compatible(nodes[i].type, nodes[j].type) else ns, ns)
        if kind == "acronym":
            acronym.add(key_of(ri, rj))
    for i, k, kind in _forced_page_pairs(nodes, pages):
        root, pt = union.find(i), pages[k]
        if union.anchor[root] is not None:
            continue
        ns, cs = float(name_page[i][k]), float(ctx_page[i][k])
        sim = max(ns, cs) if _entity_matches_page_type(nodes[i].type, pt.page_type) else ns
        holder = on_page.get(pt.title.lower())
        if holder is not None:
            note(key_of(root, holder), sim, ns)
            if kind == "acronym":
                acronym.add(key_of(root, holder))
            continue
        old = page_asks.get((root, pt.title.lower()))
        page_asks[(root, pt.title.lower())] = (
            (ns, sim, pt, kind == "acronym") if old is None
            else (max(old[0], ns), max(old[1], sim), pt, old[3] or kind == "acronym")
        )

    # Closest by meaning (_MEANING_CANDIDATES): pairs none of the above asks.
    meaning_best: dict[tuple[int, int], tuple[float, float]] = {}
    meaning_pages: dict[tuple[int, str], tuple[float, float, ExistingPageTitle]] = {}

    def may_pair(a: _Node, names_b: list[str], type_b: str, kinds_ok: bool) -> bool:
        # A person and anything else one article ties to them ("Francis
        # Wolff" / "Candid photography") are never one thing, nor two people
        # who share only a surname.
        if not kinds_ok or (a.type == "PERSON") != (type_b == "PERSON"):
            return False
        if any(_version_clash(x, y) for x in a.names for y in names_b):
            return False
        return not (a.type == "PERSON" and type_b == "PERSON"
                    and any(_person_names_clash(x, y) for x in a.names for y in names_b))

    # Nearest first; ties by name and sources, so the input order never
    # decides which candidates are taken.
    def node_order(i: int) -> list[int]:
        return sorted(range(len(nodes)), key=lambda j: (-round(float(ctx_sim[i][j]), 6), nodes[j].name,
                                                       sorted(nodes[j].source_ids)))

    for i, nd in enumerate(nodes):
        ri = union.find(i)
        taken = 0
        for j in node_order(i):
            if taken == _MEANING_CANDIDATES or float(ctx_sim[i][j]) < _MEANING_MIN_SIMILARITY:
                break
            rj = union.find(j)
            if j == i or ri == rj or (union.anchor[ri] is not None and union.anchor[rj] is not None):
                continue
            b = nodes[j]
            if not may_pair(nd, b.names, b.type, _types_compatible(nd.type, b.type) or _kinds_cross(nd.type, b.type)):
                continue
            taken += 1
            key = key_of(ri, rj)
            if key not in best:
                old = meaning_best.get(key, (0.0, 0.0))
                meaning_best[key] = (max(old[0], float(ctx_sim[i][j])), max(old[1], float(name_sim[i][j])))
    if pages:
        meaning_page = sklearn_cosine(ctx_vecs, vectors[[row[t] for t in page_meanings]])
        for i, nd in enumerate(nodes):
            root = union.find(i)
            if union.anchor[root] is not None:
                continue
            taken = 0
            for k in sorted(range(len(pages)), key=lambda k: (-round(float(meaning_page[i][k]), 6),
                                                              pages[k].title, pages[k].page_type)):
                sim = float(meaning_page[i][k])
                if taken == _MEANING_CANDIDATES or sim < _MEANING_MIN_SIMILARITY:
                    break
                pt = pages[k]
                kinds_ok = _entity_matches_page_type(nd.type, pt.page_type) or _page_kinds_cross(nd.type, pt.page_type)
                if not may_pair(nd, [pt.title], _page_type_to_entity_type(pt.page_type), kinds_ok):
                    continue
                taken += 1
                ns = float(name_page[i][k])
                holder = on_page.get(pt.title.lower())
                if holder is not None:
                    key = key_of(root, holder)
                    if key not in best:
                        old = meaning_best.get(key, (0.0, 0.0))
                        meaning_best[key] = (max(old[0], sim), max(old[1], ns))
                elif (root, pt.title.lower()) not in page_asks:
                    old_page = meaning_pages.get((root, pt.title.lower()))
                    if old_page is None or sim > old_page[1]:
                        meaning_pages[(root, pt.title.lower())] = (ns, sim, pt)

    def sources(root: int) -> set[str]:
        return {s for k in union.members[root] for s in nodes[k].source_ids}

    def one_source(ra: int, rb: int) -> bool:
        """One source names both sides, and neither is bound to the wiki."""
        bound = union.anchor[ra] is not None or union.anchor[rb] is not None
        return not bound and bool(sources(ra) & sources(rb))

    ranked: list[tuple[AmbiguousPair, bool]] = [
        (AmbiguousPair(entity_a=ref(ra), entity_b=ref(rb), similarity=round(sim, 4), name_similarity=round(ns, 4),
                       same_source=bool(sources(ra) & sources(rb)), abbreviation=(ra, rb) in acronym),
         one_source(ra, rb))
        for (ra, rb), (sim, ns) in best.items()
    ] + [
        (AmbiguousPair(
            entity_a=ref(root),
            entity_b=EntityInput(name=pt.title, type=_page_type_to_entity_type(pt.page_type),
                                 source_id=EXISTING_PAGE_SENTINEL, context=""),
            similarity=round(sim, 4),
            name_similarity=round(ns, 4),
            abbreviation=abbreviation,
        ), False)
        for (root, _title), (ns, sim, pt, abbreviation) in page_asks.items()
    ] + [
        (AmbiguousPair(entity_a=ref(ra), entity_b=ref(rb), similarity=round(sim, 4), name_similarity=round(ns, 4),
                       same_source=bool(sources(ra) & sources(rb)), by_meaning=True),
         one_source(ra, rb))
        for (ra, rb), (sim, ns) in meaning_best.items()
    ] + [
        (AmbiguousPair(
            entity_a=ref(root),
            entity_b=EntityInput(name=pt.title, type=_page_type_to_entity_type(pt.page_type),
                                 source_id=EXISTING_PAGE_SENTINEL, context=""),
            similarity=round(sim, 4),
            name_similarity=round(ns, 4),
            by_meaning=True,
        ), False)
        for (root, _title), (ns, sim, pt) in meaning_pages.items()
    ]
    # Layer 3 answers a capped number of pairs (DISAMBIGUATE_MAX_PAIRS, cut
    # again in the route), so the order decides who is asked.
    ranked.sort(key=lambda t: _layer3_rank(*t))
    ambiguous = [pair for pair, _one_source in ranked]

    paired = ({root for key in [*best, *meaning_best] for root in key}
              | {root for root, _title in [*page_asks, *meaning_pages]})
    unresolved: list[EntityInput] = []
    for root in sorted(union.members, key=lambda r: union.members[r][0]):
        entity = nodes[root].entity
        if root not in slot and root not in paired and entity is not None:
            unresolved.append(entity)
    return EmbeddingResolveResponse(resolved=resolved, ambiguous=ambiguous, unresolved=unresolved, rerouted=rerouted)


# ---------------------------------------------------------------------------
# POST /resolve/disambiguate
# ---------------------------------------------------------------------------


# LLM iteration cap (CLAUDE.md rule #7): hard bound on pairs per
# /resolve/disambiguate request. At 10 pairs per LLM call in four groups
# (entity or concept, with or without a page side) this caps a single request
# at 63 batched calls. The app sends a session's own, smaller budget: 10 pairs
# per source it adds, at least 120 (app/src/lib/resolve-ranking.ts
# disambiguatePairCap). Excess pairs come back decision='ambiguous'
# (the app keeps ambiguous entities separate — safe degradation, never an
# over-merge). Rule #7's default-off feature flag targets expansion loops;
# disambiguation is a core resolve layer, so a hard cap bounds spend without
# silently disabling every compile.
DISAMBIGUATE_MAX_PAIRS = 600


class DisambiguateSide(EntityInput):
    """A pair side as Layer 3 receives it. `known_names` is set, possibly
    empty, only on a side bound to a page the wiki holds (the page itself,
    or a group bound to it): the page's other stored names, and the side's
    context is then the page's own summary. The model saw only one source's
    sentence for such a side, which called "Color Vision Deficiency" a
    broader term, and kept "colorblindness" apart from it (film run,
    2026-10-25). Optional, so callers without it still validate."""
    known_names: list[str] | None = None


class DisambiguatePair(AmbiguousPair):
    """An AmbiguousPair as Layer 3 receives it. `pair_id` comes back on the
    pair's verdict, so the caller matches verdicts to pairs by id, not by
    name: two pairs can carry the same names ("Mercury" PERSON / CONCEPT and
    "Mercury" LOCATION / CONCEPT), and the model may swap or re-case the
    names it copies back. Optional, so callers without ids still validate."""
    entity_a: DisambiguateSide
    entity_b: DisambiguateSide
    pair_id: str | None = None


def _llm_side(side: DisambiguateSide) -> dict[str, Any]:
    """A side as the model reads it; known_names only on a page side."""
    out: dict[str, Any] = {"name": side.name, "type": side.type, "context": side.context}
    if side.known_names is not None:
        out["known_names"] = side.known_names
    return out


class DisambiguateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    pairs: list[DisambiguatePair]
    compile_model: LLMModel = "gemini-2.5-flash"


class DisambiguateResponseItem(BaseModel):
    model_config = ConfigDict(extra='forbid')
    pair_id: str | None = None  # the request pair's pair_id
    entity_a: str
    entity_b: str
    decision: str           # "same" | "different" | "ambiguous"
    canonical: str | None = None
    reason: str


class DisambiguateResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    results: list[DisambiguateResponseItem]  # one per request pair, in request order
    # Pairs whose LLM batch failed; they come back 'ambiguous'.
    failed_pairs: int = 0


def _folded(a: str, b: str) -> list[str]:
    """Two names as a verdict is matched on: any order, case or spacing."""
    return sorted(" ".join(n.split()).casefold() for n in (a, b))


def _verdicts_by_pair(batch: list[DisambiguatePair], results: list[Any]) -> list[Any | None]:
    """Each pair's verdict in one LLM batch. The model copies both names back
    pair by pair: a verdict at its pair's own position whose names fit that
    pair is that pair's; any other verdict goes to the one remaining pair
    its names fit. A pair no verdict fits, or whose names another remaining
    pair shares, gets none."""
    wanted = [_folded(p.entity_a.name, p.entity_b.name) for p in batch]
    out: list[Any | None] = [None] * len(batch)
    rest = []
    for k, r in enumerate(results):
        if k < len(batch) and out[k] is None and _folded(r.entity_a, r.entity_b) == wanted[k]:
            out[k] = r
        else:
            rest.append(r)
    for r in rest:
        fits = [k for k, names in enumerate(wanted) if out[k] is None and names == _folded(r.entity_a, r.entity_b)]
        if len(fits) == 1:
            out[fits[0]] = r
    return out


def _same_canonical(pair: AmbiguousPair, picked: str | None) -> str:
    """The canonical of a 'same' verdict: the model's pick when it is one of
    the two names, else the one _canonical_name picks. A re-cased name or an
    invented expansion ("APCA" -> "Advanced Perceptual Contrast Algorithm")
    would become the page title and the alias target."""
    names = [pair.entity_a.name, pair.entity_b.name]
    if picked in names:
        return picked
    return _canonical_name(names, person=pair.entity_a.type == "PERSON" and pair.entity_b.type == "PERSON")


@router.post("/resolve/disambiguate", response_model=DisambiguateResponse)
def resolve_disambiguate(req: DisambiguateRequest) -> DisambiguateResponse:
    """Layer 3 LLM disambiguation.

    Receives ambiguous pairs (0.7–0.9 cosine similarity band) and asks the
    session's compile model to decide same/different/ambiguous, up to 10
    pairs per LLM call. Returns one result per pair, in request order, each
    carrying its pair's pair_id. A batch that fails comes back 'ambiguous'
    and is counted in failed_pairs; a rate limit (429) or the daily cost
    ceiling (503) still fails the request.
    """
    from services.llm_client import (
        CostCeilingError,
        LLMCompileError,
        LLMRateLimitedError,
        disambiguate_entities,
    )

    if not req.pairs:
        return DisambiguateResponse(results=[])

    answers: list[DisambiguateResponseItem | None] = [None] * len(req.pairs)

    def answer(k: int, decision: str, reason: str, canonical: str | None = None) -> None:
        p = req.pairs[k]
        answers[k] = DisambiguateResponseItem(
            pair_id=p.pair_id, entity_a=p.entity_a.name, entity_b=p.entity_b.name,
            decision=decision, canonical=canonical, reason=reason,
        )

    # Names whose numbers differ are different versions, never the same
    # entity: answered without an LLM call, before the cap is applied. A
    # pair asked as closest by meaning whose names share no word may be a
    # rename that changed a number ("2019-nCoV" / "SARS-CoV-2"): the model
    # judges it (_version_clash).
    llm_pairs: list[int] = []
    for k, p in enumerate(req.pairs):
        a, b = p.entity_a.name, p.entity_b.name
        if _version_clash(a, b) if p.by_meaning else _numeric_conflict(a, b) == "hard":
            answer(k, "different", "numeric_conflict: the names carry different numbers (versions are separate entities)")
        else:
            llm_pairs.append(k)

    # Enforce the LLM call cap. Truncated pairs are answered without an LLM
    # call as 'ambiguous' so callers always get one result per pair.
    capped_pairs = llm_pairs[:DISAMBIGUATE_MAX_PAIRS]
    overflow_pairs = llm_pairs[DISAMBIGUATE_MAX_PAIRS:]
    if overflow_pairs:
        logger.warning(
            "disambiguate: %d pairs requested exceeds cap %d — "
            "%d pairs returned as 'ambiguous' without LLM calls",
            len(llm_pairs), DISAMBIGUATE_MAX_PAIRS, len(overflow_pairs),
        )
    for k in overflow_pairs:
        answer(k, "ambiguous", f"cap_exceeded: request had more than {DISAMBIGUATE_MAX_PAIRS} pairs; "
                               "pair not sent to LLM, entities kept separate")

    # Partition pairs by kind: concept pairs (either side CONCEPT) get the
    # stricter concept-disambiguation prompt; the rest use the entity prompt.
    # Concepts have fuzzier boundaries — share vocabulary across distinct
    # ideas — so the concept prompt errs toward "different" in the gray band.
    # Pairs with a side bound to a page go in batches of their own: only
    # those batches get the page rules (llm_client._DISAMBIGUATION_WIKI_PAGE),
    # which in every batch turned an asset and its platform into "same".
    is_concept = {k: "CONCEPT" in (req.pairs[k].entity_a.type, req.pairs[k].entity_b.type) for k in capped_pairs}
    has_page = {k: req.pairs[k].entity_a.known_names is not None or req.pairs[k].entity_b.known_names is not None
                for k in capped_pairs}
    failed = 0

    def _call_in_batches(indices: list[int], pair_kind: str) -> None:
        nonlocal failed
        for batch_start in range(0, len(indices), 10):
            batch = indices[batch_start:batch_start + 10]
            payload = [
                {"entity_a": _llm_side(p.entity_a), "entity_b": _llm_side(p.entity_b), "same_source": p.same_source}
                for p in (req.pairs[k] for k in batch)
            ]
            try:
                resp = disambiguate_entities(payload, model=req.compile_model, pair_kind=pair_kind)
            except LLMRateLimitedError as e:
                raise HTTPException(status_code=429, detail=str(e)) from e
            except CostCeilingError as e:
                raise HTTPException(status_code=503, detail=str(e)) from e
            except LLMCompileError as e:
                # The providers charge the daily cap inside the call, so the
                # ceiling arrives wrapped; it still stops the request.
                if isinstance(e.__cause__, CostCeilingError):
                    raise HTTPException(status_code=503, detail=str(e.__cause__)) from e
                # One bad batch (unparseable JSON, a dropped call) leaves its
                # pairs undecided, kept separate like an 'ambiguous' verdict;
                # the other batches' verdicts, already paid for, still count.
                logger.warning("disambiguate: batch of %d pairs failed: %s", len(batch), e)
                failed += len(batch)
                for k in batch:
                    answer(k, "ambiguous", f"llm_failed: {e}"[:300])
                continue

            verdicts = _verdicts_by_pair([req.pairs[k] for k in batch], resp.results)
            for k, r in zip(batch, verdicts):
                if r is None:
                    answer(k, "ambiguous", "no_verdict: the model returned no verdict for this pair")
                elif r.decision == "same":
                    answer(k, r.decision, r.reason, _same_canonical(req.pairs[k], r.canonical))
                else:
                    answer(k, r.decision, r.reason, r.canonical)

    for pair_kind, concept in (("entity", False), ("concept", True)):
        for page in (False, True):
            indices = [k for k in capped_pairs if is_concept[k] == concept and has_page[k] == page]
            if indices:
                _call_in_batches(indices, pair_kind)

    results = [a for a in answers if a is not None]
    assert len(results) == len(req.pairs)
    return DisambiguateResponse(results=results, failed_pairs=failed)
