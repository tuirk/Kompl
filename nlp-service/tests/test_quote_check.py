"""Soft quote check (services/quote_check.py, plan 3.2 / D4): a mismatch is
noted, never a reason to drop; a verified quote is the source's own text."""

from types import SimpleNamespace

from services.quote_check import (
    QUOTE_FUZZY_MIN_CHARS,
    SourceText,
    check_extraction,
    check_quote,
    skeleton,
)

SOURCE = """\
# Release notes

Published **March 5, 2024** by the [Mozilla team](https://mozilla.org/team).

> Firefox 124 ships a new “tab groups” feature for every desktop user.[12]

The | table | row
|---|---|
| Gecko | engine |

Since 2023 the browser has used the Rust-based `Stylo` engine for CSS, and
its snake_case config keys did not change.
"""


def _check(quote):
    return check_quote(quote, SourceText(SOURCE))


def test_exact_quote_is_verified_and_stored_in_the_sources_words():
    quote, ok = _check('firefox 124 ships a new "tab groups" feature for every desktop user.')
    assert ok is True
    # The source's case and its folded quote marks; the [12] marker is gone.
    assert quote == 'Firefox 124 ships a new "tab groups" feature for every desktop user.'


def test_markdown_links_emphasis_and_line_breaks_do_not_break_a_match():
    assert _check("Published March 5, 2024 by the Mozilla team.")[1] is True
    quote, ok = _check(
        "Since 2023 the browser has used the Rust-based Stylo engine for CSS, "
        "and its snake_case config keys did not change."
    )
    assert ok is True
    assert "snake_case" in quote


def test_a_small_slip_is_verified_as_the_sources_window():
    quote, ok = _check("Since 2023 the browser has used the Rust based Stylo engine for CSS")
    assert ok is True
    assert quote.startswith("Since 2023 the browser has used the Rust-based Stylo engine")


def test_a_paraphrase_is_kept_but_not_verified():
    written = "Mozilla added tab grouping to all desktop versions of Firefox."
    assert _check(written) == (written, False)


def test_a_changed_word_in_a_short_quote_is_not_verified():
    # Too short for the fuzzy step: one word decides the meaning.
    changed = "used the Go-based Stylo"
    assert len(changed) < QUOTE_FUZZY_MIN_CHARS
    assert _check(changed) == (changed, False)


def test_an_ellipsis_quote_matches_its_parts_in_order():
    quote, ok = _check("Since 2023 the browser has used ... config keys did not change.")
    assert ok is True
    assert quote == "Since 2023 the browser has used ... config keys did not change."
    assert _check("config keys did not change ... Since 2023 the browser")[1] is False


def test_no_quote_is_none_and_never_an_error():
    assert _check(None) == (None, None)
    assert _check("   ") == (None, None)


def test_skeleton_matches_the_resolver_rule():
    assert skeleton("GPT-4") == skeleton("gpt 4") == "gpt4"
    assert skeleton("C++") != skeleton("C#") != skeleton("C")


def _claim(quote):
    return SimpleNamespace(quote=quote, quote_verified=None)


def _rel(src, dst, quote=None):
    return SimpleNamespace(from_entity=src, to=dst, quote=quote, quote_verified=None, ends_listed=None)


def test_check_extraction_marks_every_item_and_drops_nothing():
    claims = [_claim("Firefox 124 ships a new tab groups feature"), _claim("made up"), _claim(None)]
    rels = [
        _rel("Firefox 124", "Gecko", "The browser has used the Rust-based Stylo engine for CSS"),
        _rel("firefox-124", "Servo"),
    ]
    report = check_extraction(claims, rels, ["Firefox 124", "Gecko", "Stylo"], SOURCE)

    assert [c.quote_verified for c in claims] == [True, False, None]
    assert [r.quote_verified for r in rels] == [True, None]
    assert [r.ends_listed for r in rels] == [True, False]
    assert report.claims == 3 and report.claims_quoted == 2 and report.claims_verified == 1
    assert report.relations == 2 and report.relations_verified == 1
    assert report.unlisted_ends == ("Servo",)


NEGATED = """\
Analysts said the venture is unlikely to succeed. Smith said she resigned in
2019 after the merger. Он неуспешно завершил проект. 他于2019年辞职并离开公司。
"""


def test_a_quote_must_start_and_end_on_word_boundaries():
    source = SourceText(NEGATED)
    for inside in ("likely to succeed", "he resigned in 2019", "she resigned in 201", "успешно завершил проект"):
        assert check_quote(inside, source) == (inside, False), inside
    assert check_quote("she resigned in 2019", source) == ("she resigned in 2019", True)
    assert check_quote("неуспешно завершил проект", source)[1] is True
    # Chinese is written without spaces: a quote may stop inside a run of it.
    assert check_quote("他于2019年辞职", source) == ("他于2019年辞职", True)


def test_an_ellipsis_quote_needs_whole_words_and_its_parts_close_together():
    source = SourceText(NEGATED)
    assert check_quote("Analysts ... likely to", source) == ("Analysts ... likely to", False)
    assert check_quote("Analysts ... unlikely to", source) == ("Analysts ... unlikely to", True)
    # Long enough for the fuzzy step, which stores the source's whole words.
    assert check_quote("Analysts said the venture is ... likely to succeed", source) == (
        "Analysts said the venture is unlikely to succeed.",
        True,
    )
    far = SourceText("The board met on Monday. " + "Other business. " * 40 + "Shareholders approved the merger.")
    assert check_quote("The board met on ... approved the merger", far)[1] is False
    near = SourceText("The board met on Monday. Shareholders approved the merger.")
    assert check_quote("The board met on ... approved the merger", near)[1] is True
    # The parts may repeat: the pair that stands close together counts.
    twice = SourceText("The board met on Monday. " + "Other business. " * 40 + "The board met on Friday; it approved the merger.")
    assert check_quote("The board met on ... approved the merger", twice)[1] is True
