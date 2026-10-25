"""Entity resolution endpoints — Part 2b.

Three-layer cascading matcher that resolves entity duplicates across sources
in a session:

  POST /resolve/fuzzy         — Layer 1: spellings of one name (exact,
                                  skeleton, plural, near-spelling, acronym,
                                  "Full Name (ABBR)"), existing aliases and
                                  page titles
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
    are left to Layers 2/3 unless both are people.
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
    method: str   # "exact"|"skeleton"|"plural"|"levenshtein"|"jaro_winkler"|"acronym"|"parenthetical"|"person_subset"|"person_initials"|"existing_alias"|"embedding"|"existing_page_title"


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
    """Return True if short (uppercase) is the acronym of long."""
    initials = _initials(long)
    return initials is not None and short.upper() == initials


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
    another. For people a one-letter slip is a different surname
    ("Anderson" / "Andersen"), so the single-word edit rule is off."""
    from rapidfuzz.distance import JaroWinkler, Levenshtein

    sa, sb = _skeleton(a), _skeleton(b)
    if sa and sa == sb:
        return "skeleton"
    if _is_simple_plural(a, b):
        return "plural"

    ta, tb = _name_tokens(a), _name_tokens(b)
    al, bl = a.lower(), b.lower()
    if len(ta) >= 2 and len(tb) >= 2:
        if _same_words_but_spelling(ta, tb):
            if Levenshtein.distance(al, bl) <= 2:
                return "levenshtein"
            if JaroWinkler.similarity(al, bl) >= 0.92:
                return "jaro_winkler"
    elif not person and len(sa) >= 8 and len(sb) >= 8 and Levenshtein.distance(sa, sb) == 1:
        # One word: a single slip in a long name ("Kubernetes" / "Kubernetis").
        # Short words one letter apart are usually two things ("Chrome" /
        # "Chroma").
        return "levenshtein"

    if _is_acronym(a, b) or _is_acronym(b, a):
        return "acronym"

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
    (element)"), and neither does a bracket holding a year or a qualifier."""
    if not (a.rstrip().endswith(")") or b.rstrip().endswith(")")):
        return None
    pa, pb = _split_parenthetical(a), _split_parenthetical(b)
    if (pa is None) == (pb is None):
        return None
    (base, inner), other = (pa, b) if pa is not None else (pb, a)
    if not _is_abbreviation(inner, base):
        return None
    if _skeleton(other) == _skeleton(inner) or _is_acronym(other, base):
        return "abbreviation"
    if _skeleton(other) == _skeleton(base) or _is_acronym(inner, other):
        return "expansion"
    return None


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

    Layer 2 embedding similarity handles the legitimate cross-session cases
    (e.g. "Andrej Karpathy" ↔ existing "Karpathy" page) semantically,
    sending borderline pairs to Layer 3 LLM disambiguation.
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
    """A capitalised acronym and the page title it abbreviates, or the other
    way round ("WCAG" / "Web Content Accessibility Guidelines"), also when
    the long form carries it in brackets ("Web Content Accessibility
    Guidelines (WCAG)"). Binds across kinds: sources type the short form ORG
    or PRODUCT and the long one CONCEPT."""
    short, long = sorted((name, title), key=len)
    if not short.isupper():
        return False
    if _is_acronym(short, long):
        return _cross_session_method(name, title) == "acronym"
    if _parenthetical_match(short, long) == "abbreviation":
        return _cross_session_method(name, title) == "parenthetical"
    return False


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
    """Keys that let _partner_key find every name _fuzzy_method or
    _cross_session_method can match with this one:
      - exact, skeleton and plural: the lower-case name, the skeleton and
        the skeleton without a plural ending;
      - two or more words: the word count and the head word without a
        plural ending (_same_words_but_spelling);
      - one slip in a long name: the skeleton with any one letter dropped;
      - acronym: the name in capitals ("caps"), which meets the initials of
        a longer name ("init");
      - "Full Name (ABBR)": the same keys for the bracket and the full name;
      - people (person=True): each word, for surname and initial matches.
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
    if person:
        keys.update(("token", t) for t in tokens)
    return keys


def _partner_key(key: tuple[str, str]) -> tuple[str, str]:
    """The key a matching name carries: the same one, except that a name in
    capitals meets the initials of another and the other way round. Two
    long names with the same initials are never compared for it."""
    kind, value = key
    return ({"caps": "init", "init": "caps"}.get(kind, kind), value)


def _title_key(name: str) -> str:
    """How a name meets an existing page title exactly: Unicode NFC, no
    surrounding spaces, any case ("OpenAI " is the page "OpenAI")."""
    return unicodedata.normalize("NFC", name).strip().lower()


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
    """Union-Find that refuses merges a pairwise check can't see: chains that
    would put "Python 2" and "Python 3" in one group, two groups anchored to
    different pages, or two different people who share a surname."""

    def __init__(self, entities: list[EntityInput], anchors: dict[int, str] | None = None) -> None:
        self.entities = entities
        self.uf = _UnionFind(len(entities))
        self.members: dict[int, list[int]] = {i: [i] for i in range(len(entities))}
        self.anchor: dict[int, str | None] = {i: (anchors or {}).get(i) for i in range(len(entities))}
        self.methods: dict[int, set[str]] = {i: set() for i in range(len(entities))}

    def find(self, i: int) -> int:
        return self.uf.find(i)

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
        else:
            names_i = [self.entities[k].name for k in self.members[ri]]
            names_j = [self.entities[k].name for k in self.members[rj]]
            if any(_numeric_conflict(x, y) for x in names_i for y in names_j):
                return False
            if _all_person(self.entities, self.members[ri]) and _all_person(self.entities, self.members[rj]):
                if any(_person_names_clash(x, y) for x in names_i for y in names_j):
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
    (instant resolution for returning sessions), then near-spellings of page
    titles, then pairwise spelling criteria (exact, skeleton, plural,
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

    # Build existing alias lookup: alias_lower → canonical
    alias_lookup: dict[str, str] = {
        ea.alias.lower(): ea.canonical for ea in req.existing_aliases
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

    # Pairwise fuzzy matching over the pairs that share a blocking key, in
    # (i, j) order. The guard refuses merges that would chain different
    # versions, different existing pages or different people into one group.
    keys = [_block_keys(e.name, person=e.type == "PERSON") for e in entities]
    by_key: dict[tuple[str, str], list[int]] = {}
    for i, own in enumerate(keys):
        for key in own:
            by_key.setdefault(key, []).append(i)
    for i in range(n):
        partners = {j for key in keys[i] for j in by_key.get(_partner_key(key), ()) if j > i}
        for j in sorted(partners):
            if guard.find(i) == guard.find(j):
                continue  # already same group
            if not _types_compatible(entities[i].type, entities[j].type):
                continue
            person_pair = entities[i].type == "PERSON" and entities[j].type == "PERSON"
            method = _fuzzy_method(entities[i].name, entities[j].name, person_pair=person_pair)
            if method:
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
            "person_subset", "person_initials", "acronym", "parenthetical",
        ]
        used_methods = guard.methods[root]
        best_method = next((m for m in method_priority if m in used_methods), "fuzzy")

        resolved.append(ResolvedGroup(
            canonical=canon,
            type=entities[members[0]].type,
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


def _layer3_rank(pair: AmbiguousPair, one_source: bool) -> tuple[bool, bool, float, float]:
    """Sort key for Layer 3's capped budget (DISAMBIGUATE_MAX_PAIRS); the
    route ranks the same way (app/src/lib/resolve-ranking.ts). Tiers first:
    a pair against the wiki (a page, or a group bound to one) or across
    sources before a pair whose two sides one source names. A list article
    ("Kaunas Castle / Cathedral / Town Hall / Fortress ...") gives many of
    those, usually different things, and they used to push out the rest.
    Within a tier an abbreviation and its long form first, since their
    names score low ("ETH" / "Ethereum"); then name similarity, so a pair
    alike only in context ("Set collection" / "Route planning", 0.98 by
    context, 0.10 by name) never buys a slot; then similarity."""
    a, b = pair.entity_a.name, pair.entity_b.name
    abbreviation = _is_abbreviation(a, b) or _is_abbreviation(b, a)
    return (one_source, not abbreviation, -pair.name_similarity, -pair.similarity)


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
    return ResolvedGroup(
        canonical=canonical, type=lead.type, aliases=aliases, source_ids=source_ids, method=method,
    ), context


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
        in common, and no difference in numbers or extra words;
      - ambiguous (Layer 3): otherwise, when either similarity is ≥ 0.7; a
        CONCEPT against ORG/PRODUCT/PERSON/LOCATION/EVENT when the names
        alone are;
      - different: the rest, and two people who share only a surname.

    Cross-session: an unanchored node whose best page title passes the merge
    test (kinds must match) is anchored to it, method 'existing_page_title';
    a borderline page comes back as an AmbiguousPair whose entity_b carries
    EXISTING_PAGE_SENTINEL. Groups Layer 1 anchored (existing_page_title or
    existing_alias) are not compared with page titles again, and two nodes
    anchored to different pages are never merged or paired.

    `resolved` holds the final state of every group passed in (unchanged if
    nothing joined it), followed by the groups Layer 2 formed. A group in an
    AmbiguousPair carries source_id GROUP_SENTINEL_PREFIX + its index in
    `resolved`. Ambiguous pairs come ranked for Layer 3's capped budget
    (_layer3_rank): pairs against the wiki or across sources before pairs
    one source names both sides of; within each, abbreviations first, then
    name similarity, then similarity. Context likeness alone, the signal
    behind the wrong merges, never buys a slot.
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
    texts = list(dict.fromkeys([nd.name for nd in nodes] + [nd.text for nd in nodes] + [pt.title for pt in pages]))
    vectors = model.encode(texts, convert_to_numpy=True)
    row = {t: k for k, t in enumerate(texts)}
    name_vecs = vectors[[row[nd.name] for nd in nodes]]
    ctx_vecs = vectors[[row[nd.text] for nd in nodes]]

    # Cross-session: compare each unanchored node with the existing page
    # titles; the page asked about is the one whose title is most like the name.
    page_pairs: list[tuple[float, float, int, ExistingPageTitle]] = []  # (name sim, sim, node, page)
    if pages:
        page_vecs = vectors[[row[pt.title] for pt in pages]]
        name_page: Any = sklearn_cosine(name_vecs, page_vecs)
        ctx_page: Any = sklearn_cosine(ctx_vecs, page_vecs)
        for i, nd in enumerate(nodes):
            if nd.anchor is not None:
                continue
            anchor_to: tuple[float, ExistingPageTitle] | None = None
            ask_about: tuple[float, float, ExistingPageTitle] | None = None
            for j, pt in enumerate(pages):
                same_kind = _entity_matches_page_type(nd.type, pt.page_type)
                if not same_kind and not _page_kinds_cross(nd.type, pt.page_type):
                    continue
                ns, cs = float(name_page[i][j]), float(ctx_page[i][j])
                sim = max(ns, cs) if same_kind else ns
                if sim < _AMBIGUOUS_SIMILARITY:
                    continue
                guard = _names_guard(nd.names, [pt.title])
                if guard == "hard":
                    continue  # a page for a different version is never the same topic
                if same_kind and guard is None and min(ns, cs) > _MERGE_SIMILARITY:
                    if anchor_to is None or min(ns, cs) > anchor_to[0]:
                        anchor_to = (min(ns, cs), pt)
                elif ask_about is None or (ns, sim) > ask_about[:2]:
                    ask_about = (ns, sim, pt)
            if anchor_to is not None:
                nd.anchor = anchor_to[1].title
            elif ask_about is not None:
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
        if same_kind and guard is None and min(ns, cs) > _MERGE_SIMILARITY \
                and not set(a.source_ids) & set(b.source_ids):
            merges.append((min(ns, cs), max(ns, cs), ns, i, j))
        else:
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

    for sim, ns, i, j in pairs:
        ri, rj = union.find(i), union.find(j)
        if ri == rj or (union.anchor[ri] is not None and union.anchor[rj] is not None):
            continue
        note((ri, rj) if union.members[ri][0] < union.members[rj][0] else (rj, ri), sim, ns)
    on_page = {anchor.lower(): root for root, anchor in union.anchor.items() if anchor is not None}
    page_best: dict[int, tuple[float, float, ExistingPageTitle]] = {}  # root → (name sim, sim, page)
    for ns, sim, i, pt in page_pairs:
        root = union.find(i)
        if union.anchor[root] is not None:
            continue  # anchored after all: not compared with pages again
        holder = on_page.get(pt.title.lower())
        if holder is not None:
            # Another node was anchored to that page here: ask about its group.
            note((root, holder) if union.members[root][0] < union.members[holder][0] else (holder, root), sim, ns)
        elif root not in page_best or (ns, sim) > page_best[root][:2]:
            page_best[root] = (ns, sim, pt)

    def sources(root: int) -> set[str]:
        return {s for k in union.members[root] for s in nodes[k].source_ids}

    def one_source(ra: int, rb: int) -> bool:
        """One source names both sides, and neither is bound to the wiki."""
        bound = union.anchor[ra] is not None or union.anchor[rb] is not None
        return not bound and bool(sources(ra) & sources(rb))

    ranked: list[tuple[AmbiguousPair, bool]] = [
        (AmbiguousPair(entity_a=ref(ra), entity_b=ref(rb), similarity=round(sim, 4), name_similarity=round(ns, 4)),
         one_source(ra, rb))
        for (ra, rb), (sim, ns) in best.items()
    ] + [
        (AmbiguousPair(
            entity_a=ref(root),
            entity_b=EntityInput(name=pt.title, type=_page_type_to_entity_type(pt.page_type),
                                 source_id=EXISTING_PAGE_SENTINEL, context=""),
            similarity=round(sim, 4),
            name_similarity=round(ns, 4),
        ), False)
        for root, (ns, sim, pt) in page_best.items()
    ]
    # Layer 3 answers a capped number of pairs (DISAMBIGUATE_MAX_PAIRS, cut
    # again in the route), so the order decides who is asked.
    ranked.sort(key=lambda t: _layer3_rank(*t))
    ambiguous = [pair for pair, _one_source in ranked]

    paired = {root for key in best for root in key} | set(page_best)
    unresolved: list[EntityInput] = []
    for root in sorted(union.members, key=lambda r: union.members[r][0]):
        entity = nodes[root].entity
        if root not in slot and root not in paired and entity is not None:
            unresolved.append(entity)
    return EmbeddingResolveResponse(resolved=resolved, ambiguous=ambiguous, unresolved=unresolved)


# ---------------------------------------------------------------------------
# POST /resolve/disambiguate
# ---------------------------------------------------------------------------


# LLM iteration cap (CLAUDE.md rule #7): hard bound on pairs per
# /resolve/disambiguate request. At 10 pairs per LLM call this caps a single
# request at 12 batched calls. Excess pairs come back decision='ambiguous'
# (the app keeps ambiguous entities separate — safe degradation, never an
# over-merge). Rule #7's default-off feature flag targets expansion loops;
# disambiguation is a core resolve layer, so a hard cap bounds spend without
# silently disabling every compile.
DISAMBIGUATE_MAX_PAIRS = 120


class DisambiguatePair(AmbiguousPair):
    """An AmbiguousPair as Layer 3 receives it. `pair_id` comes back on the
    pair's verdict, so the caller matches verdicts to pairs by id, not by
    name: two pairs can carry the same names ("Mercury" PERSON / CONCEPT and
    "Mercury" LOCATION / CONCEPT), and the model may swap or re-case the
    names it copies back. Optional, so callers without ids still validate."""
    pair_id: str | None = None


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
    # entity: answered without an LLM call, before the cap is applied.
    llm_pairs: list[int] = []
    for k, p in enumerate(req.pairs):
        if _numeric_conflict(p.entity_a.name, p.entity_b.name) == "hard":
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
    is_concept = {k: "CONCEPT" in (req.pairs[k].entity_a.type, req.pairs[k].entity_b.type) for k in capped_pairs}
    concept_pairs = [k for k in capped_pairs if is_concept[k]]
    entity_pairs = [k for k in capped_pairs if not is_concept[k]]
    failed = 0

    def _call_in_batches(indices: list[int], pair_kind: str) -> None:
        nonlocal failed
        for batch_start in range(0, len(indices), 10):
            batch = indices[batch_start:batch_start + 10]
            payload = [
                {
                    "entity_a": {"name": p.entity_a.name, "type": p.entity_a.type, "context": p.entity_a.context},
                    "entity_b": {"name": p.entity_b.name, "type": p.entity_b.type, "context": p.entity_b.context},
                }
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

    if entity_pairs:
        _call_in_batches(entity_pairs, "entity")
    if concept_pairs:
        _call_in_batches(concept_pairs, "concept")

    results = [a for a in answers if a is not None]
    assert len(results) == len(req.pairs)
    return DisambiguateResponse(results=results, failed_pairs=failed)
