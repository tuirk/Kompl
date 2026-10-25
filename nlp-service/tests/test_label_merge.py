"""clean_label_merges: what the app may apply from the label consolidation call.

The model only proposes; this keeps the merges that rename a label added in
this compile into a label it was given, spelled as given, without chains or
cycles. Labels the wiki already had are never renamed.
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
