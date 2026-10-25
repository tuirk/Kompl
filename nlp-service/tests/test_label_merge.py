"""clean_label_merges: what the app may apply from the label consolidation call.

The model only proposes; this keeps the merges that rename a label added in
this compile into a label it was given, spelled as given, without chains or
cycles. Labels the wiki already had are never renamed. With page counts,
only the smaller label moves into the bigger, and a contained name merges
only as a part of a combined label or as a 1-2 page label.
"""

from __future__ import annotations

from services.label_merge import clean_label_merges
from services.llm_client import LabelMerge

EXISTING = ["Cryptocurrency", "Machine Learning", "Artificial Intelligence", "Travel"]


def _m(label: str, into: str, reason: str = "same category") -> LabelMerge:
    return LabelMerge(label=label, into=into, reason=reason)


def _pairs(items: list[dict[str, str]]) -> list[tuple[str, str]]:
    return [(i["label"], i["into"]) for i in items]


def test_keeps_a_new_label_merged_into_an_existing_one_spelled_as_given():
    items = clean_label_merges([_m("crypto", "CRYPTOCURRENCY", "short form")], EXISTING, ["Crypto"])
    assert items == [{"label": "Crypto", "into": "Cryptocurrency", "reason": "short form"}]


def test_drops_a_merge_into_a_name_it_was_not_given():
    assert clean_label_merges([_m("Crypto", "Digital Assets")], EXISTING, ["Crypto"]) == []


def test_never_renames_a_label_the_wiki_already_had():
    merges = [_m("Machine Learning", "Artificial Intelligence"), _m("Travel", "Trips")]
    assert clean_label_merges(merges, EXISTING, ["Trips"]) == [
        {"label": "Trips", "into": "Travel", "reason": "same category"},
    ]


def test_an_existing_label_named_first_is_turned_around():
    assert _pairs(clean_label_merges([_m("Cryptocurrency", "Crypto")], EXISTING, ["Crypto"])) == [
        ("Crypto", "Cryptocurrency"),
    ]


def test_drops_self_merges_and_unknown_labels():
    merges = [_m("Crypto", "crypto"), _m("Blockchain", "Cryptocurrency")]
    assert clean_label_merges(merges, EXISTING, ["Crypto"]) == []


def test_the_first_merge_of_a_label_wins():
    merges = [_m("AI", "Artificial Intelligence"), _m("AI", "Machine Learning")]
    assert _pairs(clean_label_merges(merges, EXISTING, ["AI"])) == [("AI", "Artificial Intelligence")]


def test_chains_end_at_the_last_label():
    merges = [_m("Web Dev", "Webdev"), _m("Webdev", "Web Development")]
    assert _pairs(clean_label_merges(merges, [], ["Web Dev", "Webdev", "Web Development"])) == [
        ("Web Dev", "Web Development"),
        ("Webdev", "Web Development"),
    ]


def test_an_exact_spelling_wins_over_a_case_variant():
    merges = [_m("Web development", "Web Development")]
    assert _pairs(clean_label_merges(merges, [], ["Web development", "Web Development"])) == [
        ("Web development", "Web Development"),
    ]


def test_a_merge_that_would_close_a_cycle_is_dropped():
    merges = [_m("Films", "Movies"), _m("Movies", "Films")]
    assert _pairs(clean_label_merges(merges, [], ["Films", "Movies"])) == [("Films", "Movies")]


def test_output_follows_the_order_of_the_new_labels():
    merges = [_m("Trips", "Travel"), _m("Crypto", "Cryptocurrency")]
    assert _pairs(clean_label_merges(merges, EXISTING, ["Crypto", "Trips"])) == [
        ("Crypto", "Cryptocurrency"),
        ("Trips", "Travel"),
    ]


# ── Page counts: smaller into bigger, and the two containment rules ──────────

# The film run's labels after its first compile (owner review 2026-10-25).
FILM = {
    "Graphic Design": 33,
    "Web Accessibility & Standards": 24,
    "Arts & Culture": 20,
    "Design & Accessibility": 20,
    "Web Development": 7,
    "Typography & Graphic Design": 6,
    "Web Accessibility": 2,
    "Design": 1,
}


def test_film_labels_merge_only_the_part_and_the_one_page_label():
    """Whatever else the model proposes, only the two merges the rules allow
    survive: a part into its combined label, a 1-page label into a more-used
    label that contains its name. Bigger never moves into smaller."""
    labels = list(FILM)
    merges = [
        _m("Web Accessibility", "Web Accessibility & Standards", "one part of the combined label"),
        _m("Design", "Graphic Design", "small label inside a more-used one"),
        # Bigger into smaller: Graphic Design (33) never moves into 6 pages.
        _m("Graphic Design", "Typography & Graphic Design"),
        _m("Design & Accessibility", "Design"),
        # A combined label never folds into one of its parts.
        _m("Typography & Graphic Design", "Graphic Design"),
    ]
    assert _pairs(clean_label_merges(merges, [], labels, FILM)) == [
        ("Web Accessibility", "Web Accessibility & Standards"),
        ("Design", "Graphic Design"),
    ]


def test_bigger_never_moves_into_smaller():
    counts = {"Crypto": 5, "Cryptocurrency": 2}
    assert clean_label_merges([_m("Crypto", "Cryptocurrency")], [], ["Crypto", "Cryptocurrency"], counts) == []


def test_equal_counts_may_merge():
    counts = {"Films": 3, "Movies": 3}
    assert _pairs(clean_label_merges([_m("Films", "Movies")], [], ["Films", "Movies"], counts)) == [("Films", "Movies")]


def test_a_new_label_bigger_than_the_existing_one_stays():
    # A compile never renames the wiki's label, and the new one is bigger.
    counts = {"Cryptocurrency": 1, "Crypto": 4}
    assert clean_label_merges([_m("Crypto", "Cryptocurrency")], EXISTING, ["Crypto"], counts) == []


def test_a_part_merges_into_its_combined_label_at_any_size_below_it():
    counts = {"Machine Learning": 9, "Machine Learning & AI": 12}
    merges = [_m("Machine Learning", "Machine Learning & AI")]
    assert _pairs(clean_label_merges(merges, [], list(counts), counts)) == [("Machine Learning", "Machine Learning & AI")]


def test_parts_split_on_and_slash_and_comma():
    counts = {"Film": 2, "Television": 3, "Music": 4, "Film and Television": 10, "Art / Music": 10, "History, Television": 10}
    merges = [_m("Film", "Film and Television"), _m("Music", "Art / Music"), _m("Television", "History, Television")]
    assert _pairs(clean_label_merges(merges, [], list(counts), counts)) == [
        ("Film", "Film and Television"),
        ("Television", "History, Television"),
        ("Music", "Art / Music"),
    ]


def test_a_contained_name_with_more_than_two_pages_is_a_narrower_topic():
    # "Learning" sits inside "Machine Learning" but is not one of its parts.
    counts = {"Learning": 3, "Machine Learning": 20}
    assert clean_label_merges([_m("Learning", "Machine Learning")], [], list(counts), counts) == []


def test_a_one_or_two_page_label_merges_into_a_label_containing_its_name():
    counts = {"Design": 2, "Graphic Design": 33}
    assert _pairs(clean_label_merges([_m("Design", "Graphic Design")], [], list(counts), counts)) == [
        ("Design", "Graphic Design"),
    ]


def test_a_longer_name_never_folds_into_a_word_it_contains():
    # Narrower into broader by name ("Graphic Design" into "Design") is not
    # one of the two rules, whatever the counts.
    counts = {"Graphic Design": 1, "Design": 30}
    assert clean_label_merges([_m("Graphic Design", "Design")], [], list(counts), counts) == []


def test_a_combined_label_never_folds_into_one_of_its_parts():
    counts = {"Typography & Graphic Design": 6, "Graphic Design": 33}
    merges = [_m("Typography & Graphic Design", "Graphic Design")]
    assert clean_label_merges(merges, [], list(counts), counts) == []


def test_containment_needs_whole_words():
    # "Art" is not a word of "Martial Arts", so the 1-2 page limit does not
    # apply; the prompt's bans decide such a merge.
    counts = {"Art": 3, "Martial Arts": 5}
    assert _pairs(clean_label_merges([_m("Art", "Martial Arts")], [], list(counts), counts)) == [("Art", "Martial Arts")]


def test_without_page_counts_only_the_name_rules_apply():
    # Callers that send no counts (older apps): no size check; a contained
    # name only merges as one part of a combined label.
    merges = [_m("Web Accessibility", "Web Accessibility & Standards"), _m("Design", "Graphic Design")]
    labels = ["Web Accessibility", "Web Accessibility & Standards", "Design", "Graphic Design"]
    assert _pairs(clean_label_merges(merges, [], labels)) == [("Web Accessibility", "Web Accessibility & Standards")]
