"""Draft prompt contracts for the category label.

Film run (2026-10-25): with drafts offered the wiki's labels one by one,
the first source coined "Design & Accessibility" and the old rule ("You
MUST use one of these exact strings… Only invent a new category if none of
the existing ones fit") let every design source fit it: 2 labels for 92
pages. These tests pin the rule that replaced it: reuse a label only when it
names the page's main field, otherwise create one for that field, and a new
label names one field, never two joined.
"""

from __future__ import annotations

import pytest

# conftest.py stubs heavy deps before this import runs.
from services import llm_client
from services.providers import LLMResult

_SOURCE = [{"source_id": "a", "title": "Accessible Colour", "markdown": "Contrast ratios for text."}]
_PAGE_TYPES = ("source-summary", "entity", "concept", "comparison", "overview")
_JOINERS = ('"&"', '"and"', '"/"')


def _flat(text: str) -> str:
    return " ".join(text.split())


def _draft_prompts(monkeypatch, categories: list[str] | None) -> tuple[str, str]:
    """(system, user) prompts of one draft_page call; the model is never called."""
    captured = {}

    class _Provider:
        def complete(self, req):
            captured["req"] = req
            text = "---\ntitle: T\npage_type: concept\ncategory: Web Accessibility\nsummary: S.\n---\n\nBody."
            return LLMResult(text=text, parsed=None, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    llm_client.draft_page(
        page_type="concept", title="Colour Contrast", source_contents=_SOURCE, existing_categories=categories,
    )
    messages = captured["req"].messages
    return messages[0]["content"], messages[1]["content"]


def _category_block(user_prompt: str) -> str:
    return _flat(user_prompt[user_prompt.index("CATEGORY ASSIGNMENT:"):])


@pytest.mark.parametrize("page_type", _PAGE_TYPES)
def test_system_prompts_reuse_a_label_only_for_the_main_field(page_type):
    prompt = _flat(llm_client._DRAFT_PAGE_PROMPTS[page_type])
    assert "only when it names this page's main subject field" in prompt
    assert "A new category names one field in 1-3 words" in prompt
    for joiner in _JOINERS:
        assert joiner in prompt, joiner
    # The rule that let one compound label swallow every design source.
    assert "MUST use one of the exact category strings" not in prompt
    assert "none fit" not in prompt


def test_with_labels_reuse_only_the_one_naming_the_main_field(monkeypatch):
    _, user = _draft_prompts(monkeypatch, ["Design & Accessibility", "Cryptocurrency"])
    block = _category_block(user)
    assert 'Existing wiki categories: "Design & Accessibility", "Cryptocurrency"' in block
    assert "Use an existing category only when it names this page's MAIN subject field" in block
    assert "write it exactly as listed" in block
    assert "belongs to a different field than every existing category, create a new category for that field" in block
    assert "A new category names one field in 1-3 words" in block
    for joiner in _JOINERS:
        assert joiner in block, joiner
    assert "You MUST use one of these exact strings" not in block
    assert "Only invent a new category if none of the existing ones fit" not in block


def test_without_labels_name_the_main_field_with_one_field_examples(monkeypatch):
    _, user = _draft_prompts(monkeypatch, [])
    block = _category_block(user)
    assert "No existing categories yet" in block
    assert "main subject field in 1-3 words, one field only" in block
    for example in ('"Graphic Design"', '"Web Accessibility"', '"Cryptocurrency"'):
        assert example in block, example
    # No compound example for the model to copy.
    assert "AI & Machine Learning" not in block
    assert " & " not in block.replace('"&"', "")
    assert "The category field is REQUIRED" in block


@pytest.mark.parametrize("categories", ([], ["Graphic Design"]))
def test_category_assignment_stays_last(monkeypatch, categories):
    _, user = _draft_prompts(monkeypatch, categories)
    assert user.index("FINAL CHECK before answering:") < user.index("CATEGORY ASSIGNMENT:")
    assert user.rstrip().endswith("The category field is REQUIRED — do not leave it blank or omit it.")
