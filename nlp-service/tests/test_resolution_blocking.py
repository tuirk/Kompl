"""Layer 1 blocking: same result as comparing every pair, at a fraction of the cost.

/resolve/fuzzy compared every name with every other name and every page
title. 600 names against 5,000 page titles took 122 s, past the route's 60 s
limit, so resolve failed on large wikis (audit 2026-10-23). Layer 1 now
only checks pairs that share a blocking key (_block_keys). These tests pin
that no pair a rule can match is skipped, and that the output equals the
every-pair comparison.
"""

from __future__ import annotations

import json
import random
import time
from typing import Any

import pytest

from routers import resolution
from routers.resolution import (
    FuzzyResolveRequest,
    _block_keys,
    _cross_kind_acronym,
    _cross_session_method,
    _fuzzy_method,
    _partner_key,
    resolve_fuzzy,
)

# Names the rules treat specially: skeletons, plurals, head-word spellings,
# long one-slip words, acronyms, "Full Name (ABBR)", people, numbers, Unicode.
_CURATED = [
    "GPT-4", "GPT 4", "gpt4", "GPT-4o", "GPT 4 Turbo", "LLM", "LLMs", "AI", "AIs", "Llm",
    "CSS media query", "CSS media queries", "process", "processes", "policy", "policies",
    "Kubernetes", "Kubernetis", "Wikipedia", "Wikimedia", "Columbia", "Colombia",
    "colour contrast ratio", "color contrast ratio", "Contrast ratio", "Colour contrast ratios",
    "Web Content Accessibility Guidelines", "Web Content Accessibility Guidelines (WCAG)", "WCAG",
    "web content accessibility guidelines", "Continuous Integration (CI)", "CI", "Confidence Interval",
    "Machine Learning (ML)", "ML", "Maximum Likelihood", "machine learning", "Machine-Learning",
    "Product Manager", "PM", "Project Manager", "World Health Organization", "WHO",
    "Andrej Karpathy", "Karpathy", "A. Karpathy", "Andrej", "Bob Karpathy", "Paul Graham", "Paul",
    "Paul Allen", "Graham", "George Steiner", "Thomas Steiner", "Steiner", "John Edward", "John Edwards",
    "Python 2", "Python 3", "Python", "Python 3.10", "Python 3.1", "World War II", "World War 2",
    "Zürich", "Zurich", "São Paulo", "Sao Paulo", "OpenAI ", "OpenAI", "C", "C++", "C#",
    "Ethereum", "Ethereum Foundation", "ETH", "Vilnius", "Vilnius Cathedral", "London", "London Eye",
    "North Korea", "South Korea", "Kaunas City Hall", "Kaunas City Museum", "NVDA", "NAVA",
    "WebKit", "WebAIM", "Chrome", "Chroma", "APCA", "APCA contrast algorithm", "", " ", "+", "(x)",
    "Mercury (planet)", "Mercury (element)", "Mercury", "UNESCO", "UNESCO World Heritage",
    "Russian Academy of Sciences", "Prussian Academy of Sciences", "anti-aliasing and font weight",
]

_WORDS = (
    "alpha beta network protocol learning machine graph model language large vision search "
    "engine data quantum cloud server colour color contrast ratio web script kernel system "
    "design pattern market route planning city hall museum north south energy token chain "
    "query queries process processes library libraries policy policies media"
).split()


def _random_names(rng: random.Random, n: int) -> list[str]:
    names = []
    for _ in range(n):
        words = [rng.choice(_WORDS) for _ in range(rng.randint(1, 4))]
        if rng.random() < 0.5:
            words = [w.capitalize() for w in words]
        name = " ".join(words)
        roll = rng.random()
        if roll < 0.1:
            name = "".join(w[0] for w in words).upper()
        elif roll < 0.2:
            name = f"{name} ({''.join(w[0] for w in words).upper()})"
        elif roll < 0.3:
            name += "s"
        elif roll < 0.4 and len(name) > 8:
            k = rng.randrange(len(name))
            name = name[:k] + name[k + 1:]
        elif roll < 0.5:
            name = name.replace(" ", "-").lower()
        names.append(name)
    return names


def _corpus() -> list[str]:
    rng = random.Random(20261023)
    return list(dict.fromkeys(_CURATED + _random_names(rng, 150)))


def test_every_pair_a_rule_matches_shares_a_block_key():
    names = _corpus()
    keys = {nm: (_block_keys(nm), _block_keys(nm, person=True)) for nm in names}
    missed = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            for person in (False, True):
                meet_ab = any(_partner_key(k) in keys[b][person] for k in keys[a][person])
                meet_ba = any(_partner_key(k) in keys[a][person] for k in keys[b][person])
                assert meet_ab == meet_ba, (a, b)
                if meet_ab:
                    continue
                if (_fuzzy_method(a, b, person_pair=person) or _cross_session_method(a, b, person=person)
                        or _cross_kind_acronym(a, b) or _cross_kind_acronym(b, a)):
                    missed.append((a, b, person))
    assert missed == []


def _workload(seed: int, n_entities: int, n_pages: int) -> FuzzyResolveRequest:
    rng = random.Random(seed)
    types = ["ORG", "PRODUCT", "CONCEPT", "LOCATION", "PERSON", "OTHER"]
    pool = _corpus()
    pages = [{"title": rng.choice(pool) or "Untitled", "page_type": rng.choice(["entity", "concept"])}
             for _ in range(n_pages)]
    entities = [{"name": rng.choice(pool), "type": rng.choice(types), "source_id": f"s{rng.randint(1, 8)}",
                 "context": ""} for _ in range(n_entities)]
    aliases = [{"alias": rng.choice(pool), "canonical": rng.choice(pool)} for _ in range(10)]
    return FuzzyResolveRequest(entities=entities, existing_aliases=aliases, existing_page_titles=pages)


def _dump(req: FuzzyResolveRequest) -> str:
    return json.dumps(resolve_fuzzy(req).model_dump(), sort_keys=True)


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_output_equals_comparing_every_pair(seed: int, monkeypatch: pytest.MonkeyPatch):
    req = _workload(seed, n_entities=160, n_pages=400)
    blocked = _dump(req)

    def one_block(name: str, *, person: bool = False) -> set[tuple[str, str]]:  # noqa: ARG001
        return {("all", "")}

    monkeypatch.setattr(resolution, "_block_keys", one_block)
    assert blocked == _dump(req)


def test_large_session_against_large_wiki_stays_well_inside_the_route_timeout():
    """600 names × 5,000 page titles took 122 s before blocking; the route
    aborts /resolve/fuzzy at 60 s."""
    rng = random.Random(7)
    words = _WORDS + [f"term{k}" for k in range(400)]

    def name() -> str:
        return " ".join(rng.choice(words).capitalize() for _ in range(rng.randint(1, 4)))

    pages = [{"title": name(), "page_type": rng.choice(["entity", "concept"])} for _ in range(5000)]
    entities = [{"name": name() if rng.random() < 0.8 else rng.choice(pages)["title"].lower(),
                 "type": rng.choice(["ORG", "CONCEPT", "PERSON", "PRODUCT"]),
                 "source_id": f"s{rng.randint(1, 30)}", "context": ""} for _ in range(600)]
    req = FuzzyResolveRequest(entities=entities, existing_aliases=[], existing_page_titles=pages)

    start = time.perf_counter()
    resp = resolve_fuzzy(req)
    elapsed = time.perf_counter() - start

    bound = sum(1 for g in resp.resolved if g.method == "existing_page_title")
    assert bound > 0
    assert elapsed < 20, f"/resolve/fuzzy took {elapsed:.1f}s on 600 names × 5,000 titles"


def test_block_keys_cover_the_bracket_and_its_full_name():
    keys = _block_keys("Web Content Accessibility Guidelines (WCAG)")
    assert {("caps", "WCAG"), ("init", "WCAG")} <= keys
    assert ("skel", "wcag") in keys
    assert ("skel", "webcontentaccessibilityguidelines") in keys


def _pairs(names: list[str]) -> list[tuple[str, str]]:
    return [(a, b) for i, a in enumerate(names) for b in names[i + 1:]]


def test_curated_matches_are_found_through_the_keys():
    """Sanity: the curated corpus holds pairs of every kind the rules match."""
    methods: set[Any] = set()
    for a, b in _pairs(_CURATED):
        methods.add(_fuzzy_method(a, b, person_pair=False))
        methods.add(_fuzzy_method(a, b, person_pair=True))
    assert {"exact", "skeleton", "plural", "levenshtein", "acronym", "parenthetical",
            "person_subset", "person_initials"} <= methods
