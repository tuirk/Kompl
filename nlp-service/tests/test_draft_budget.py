"""services/draft_budget.py: which source documents fit a draft prompt.

Audit B4: the prompt was cut at the budget after the sources were added in
UUID order, so this session's own source could be the one cut while the
commit still credited it. These pin the replacement: new sources first and
whole, older ones by relevance, and every cut reported.
"""

from __future__ import annotations

import sys

import pytest

from services.draft_budget import (
    BLOCK_OVERHEAD_CHARS,
    MIN_PARTIAL_SOURCE_CHARS,
    cut_text,
    fit_sources,
    rank_by_relevance,
)


def _header(sc: dict) -> int:
    return len(f"--- Source: {sc['title']} ---")


def _src(source_id: str, markdown: str, *, is_new: bool = False, title: str | None = None) -> dict:
    return {"source_id": source_id, "title": title or source_id, "markdown": markdown, "is_new": is_new}


def _cost(sc: dict) -> int:
    return _header(sc) + len(sc["markdown"]) + BLOCK_OVERHEAD_CHARS


def _ids(fitted) -> list[str]:
    return [sc["source_id"] for sc in fitted.sources]


def test_everything_fits_in_the_given_order():
    sources = [_src("a", "x" * 100), _src("b", "y" * 100, is_new=True), _src("c", "z" * 100)]
    fitted = fit_sources(sources, 10_000, _header, "query")
    assert _ids(fitted) == ["b", "a", "c"]  # new first, older in the given order
    assert fitted.cuts == []
    assert all("shortened_from" not in sc for sc in fitted.sources)


def test_the_new_source_stays_whole_when_it_sorts_last():
    older = [_src(f"old{i}", f"Bitcoin mining notes {i}.\n\n" + "w" * 4_000) for i in range(5)]
    new = _src("zz-new", "Fresh article about Bitcoin.\n\n" + "n" * 3_000, is_new=True)
    room = _cost(new) + 2 * _cost(older[0])
    fitted = fit_sources([*older, new], room, _header, "Bitcoin")

    assert fitted.sources[0]["source_id"] == "zz-new"
    assert fitted.sources[0]["markdown"] == new["markdown"]
    sent = sum(_header(sc) + len(sc["markdown"]) + BLOCK_OVERHEAD_CHARS for sc in fitted.sources)
    assert sent <= room
    assert {c.source_id for c in fitted.cuts} == {sc["source_id"] for sc in older} - set(_ids(fitted))
    assert all(c.sent_chars == 0 and c.cut_chars == 4_000 + len("Bitcoin mining notes 0.\n\n") for c in fitted.cuts)


def test_older_sources_are_kept_by_relevance_most_relevant_last():
    off_topic = _src("a-cooking", "Pasta recipes with tomato and basil. " * 120)
    on_topic = _src("b-bitcoin", "Bitcoin proof of work mining secures the Bitcoin network. " * 70)
    half = _src("c-mixed", "Bitcoin is mentioned once. " + "Gardening tips for spring. " * 150)
    new = _src("new", "Bitcoin halving news.", is_new=True)
    room = _cost(new) + _cost(on_topic) + _cost(half) + 10
    fitted = fit_sources([off_topic, on_topic, half, new], room, _header, "Bitcoin proof of work mining")

    assert _ids(fitted) == ["new", "c-mixed", "b-bitcoin"]
    assert [c.source_id for c in fitted.cuts] == ["a-cooking"]


def test_the_first_older_source_that_does_not_fit_is_shortened_at_a_paragraph():
    paragraphs = "\n\n".join(f"Paragraph {i} about Ethereum. " + "e" * 400 for i in range(20))
    big = _src("big", paragraphs)
    new = _src("new", "Ethereum news.", is_new=True)
    room = _cost(new) + MIN_PARTIAL_SOURCE_CHARS + 500
    fitted = fit_sources([big, new], room, _header, "Ethereum")

    assert _ids(fitted) == ["new", "big"]
    short = fitted.sources[1]
    assert short["shortened_from"] == len(paragraphs)
    assert paragraphs.startswith(short["markdown"])
    assert short["markdown"].endswith("e")  # ends on a whole paragraph
    assert len(short["markdown"]) >= MIN_PARTIAL_SOURCE_CHARS // 2
    (cut,) = fitted.cuts
    assert cut.source_id == "big"
    assert cut.sent_chars == len(short["markdown"])
    assert cut.sent_chars + cut.cut_chars == len(paragraphs)


def test_an_older_source_that_would_keep_too_little_is_left_out():
    big = _src("big", "Solana " * 2_000)
    new = _src("new", "Solana news.", is_new=True)
    fitted = fit_sources([big, new], _cost(new) + MIN_PARTIAL_SOURCE_CHARS // 2, _header, "Solana")
    assert _ids(fitted) == ["new"]
    assert fitted.cuts[0].sent_chars == 0


def test_a_smaller_older_source_still_fits_after_a_bigger_one_is_left_out():
    big = _src("big", "Cardano staking. " * 2_000)
    small = _src("small", "Cardano staking rewards explained.")
    new = _src("new", "Cardano news.", is_new=True)
    fitted = fit_sources([big, small, new], _cost(new) + _cost(small) + 100, _header, "Cardano staking")
    assert _ids(fitted) == ["new", "small"]
    assert [c.source_id for c in fitted.cuts] == ["big"]


def test_new_sources_that_overflow_share_the_room_evenly():
    short = _src("short", "Polkadot parachains.", is_new=True)
    long_a = _src("long-a", "\n".join(f"Line {i} on Polkadot." for i in range(800)), is_new=True)
    long_b = _src("long-b", "\n".join(f"Row {i} on Polkadot." for i in range(800)), is_new=True)
    older = _src("old", "Older Polkadot article.")
    room = 6_000
    fitted = fit_sources([long_a, older, short, long_b], room, _header, "Polkadot")

    assert _ids(fitted) == ["long-a", "short", "long-b"]  # given order, older left out
    by_id = {sc["source_id"]: sc for sc in fitted.sources}
    assert by_id["short"]["markdown"] == short["markdown"]
    assert "shortened_from" in by_id["long-a"] and "shortened_from" in by_id["long-b"]
    assert abs(len(by_id["long-a"]["markdown"]) - len(by_id["long-b"]["markdown"])) < 100
    total = sum(_header(sc) + len(sc["markdown"]) + BLOCK_OVERHEAD_CHARS for sc in fitted.sources)
    assert total <= room
    assert {c.source_id for c in fitted.cuts} == {"long-a", "long-b", "old"}


def test_many_new_sources_get_usable_shares_not_slivers():
    new = [_src(f"n{i:02d}", f"Note {i} on Tezos.\n" + "t" * 5_000, is_new=True) for i in range(30)]
    room = 20_000
    fitted = fit_sources(new, room, _header, "Tezos")

    kept = _ids(fitted)
    assert kept and kept[0] == "n00"
    assert kept == [f"n{i:02d}" for i in range(len(kept))]  # the last ones are left out
    assert all(len(sc["markdown"]) >= MIN_PARTIAL_SOURCE_CHARS // 2 for sc in fitted.sources)
    total = sum(_header(sc) + len(sc["markdown"]) + BLOCK_OVERHEAD_CHARS for sc in fitted.sources)
    assert total <= room
    assert {c.source_id for c in fitted.cuts if c.sent_chars == 0} == {f"n{i:02d}" for i in range(len(kept), 30)}


def test_one_huge_new_source_is_shortened_not_dropped():
    huge = _src("huge", "Paragraph of a very long paper.\n\n" * 10_000, is_new=True)
    fitted = fit_sources([huge], 8_000, _header, "paper")
    assert _ids(fitted) == ["huge"]
    assert 0 < fitted.cuts[0].sent_chars <= 8_000


def test_ranking_falls_back_to_the_given_order(monkeypatch):
    # No scikit-learn: the caller's order decides, even against relevance.
    monkeypatch.setitem(sys.modules, "sklearn.feature_extraction.text", None)
    first = _src("first", "Gardening tips for spring. " * 80)
    second = _src("second", "Avalanche consensus and subnets. " * 60)
    new = _src("new", "Avalanche news.", is_new=True)
    fitted = fit_sources([first, second, new], _cost(new) + _cost(first) + 10, _header, "Avalanche consensus")
    assert _ids(fitted) == ["new", "first"]


def test_rank_by_relevance_keeps_the_order_without_signal():
    a, b = _src("a", "the and of"), _src("b", "a an the")
    assert rank_by_relevance("the", [a, b]) == [a, b]  # stop words only: no vocabulary
    assert rank_by_relevance("", [a, b]) == [a, b]


@pytest.mark.parametrize(
    ("text", "limit", "expected"),
    [
        ("short", 10, "short"),
        ("First para.\n\nSecond para is longer.", 20, "First para."),
        ("One line\nTwo line\nThree line", 20, "One line\nTwo line"),
        ("Sentence one. Sentence two. Sentence three.", 30, "Sentence one. Sentence two."),
        ("x" * 50, 20, "x" * 20),
    ],
)
def test_cut_text_ends_at_a_break(text, limit, expected):
    assert cut_text(text, limit) == expected
