"""Which label merges from the consolidation call the app may apply.

The model (llm_client.consolidate_labels) only proposes. A merge is kept
when it renames a label this compile added into a label the model was given,
so no label is ever invented and no label the wiki already had is renamed.
Names are matched to the spelling they were given in (exact first, then
ignoring case). Chains end at their last label and a merge that would close
a cycle is dropped, so applying the result once is final.

With page counts (owner decision 2026-10-25), two rules from the prompt are
also held here, whatever the model answers:
- between two new labels, the one with fewer pages moves into the one with
  more, never the reverse ("Graphic Design" 33 never into "Typography &
  Graphic Design" 6). A new label joins an existing one whatever the
  pages, since a compile never renames the wiki's labels (a Repair run
  sends every label as new, so the rule holds for all of them there);
- a label whose whole name sits inside the other label's name merges only
  as one part of a combined label ("Web Accessibility" into "Web
  Accessibility & Standards") or when it has 1-2 pages ("Design" into
  "Graphic Design"). Any other contained name is a narrower or broader
  topic, and a longer name never folds into a word it contains.
Drafts name one field per label (2026-10-25), so a new label never moves
into an existing combined label by being inside its name: such a label
("Design & Accessibility") may join two fields, so the new label stays.

This module NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import re
from typing import Iterable, Mapping, Protocol

# A label this small whose whole name a more-used label contains joins it.
SMALL_LABEL_PAGES = 2

# What joins the parts of a combined label: "A & B", "A and B", "A / B", "A, B".
_PART_SEPARATOR = re.compile(r"&|\+|/|,|\band\b", re.IGNORECASE)


class _Merge(Protocol):
    label: str
    into: str
    reason: str


def _speller(names: Iterable[str]):
    exact = {n: n for n in names}
    folded: dict[str, str] = {}
    for n in exact:
        folded.setdefault(n.strip().casefold(), n)

    def spell(name: str) -> str | None:
        return exact.get(name) or folded.get(name.strip().casefold())

    return spell


def _words(name: str) -> list[str]:
    return re.findall(r"\w+", name.casefold())


def _parts(name: str) -> set[tuple[str, ...]]:
    """The parts of a combined label as word tuples; one part when not combined."""
    return {tuple(_words(p)) for p in _PART_SEPARATOR.split(name) if _words(p)}


def _inside(small: str, big: str) -> bool:
    """small's words appear, in order and together, in big's longer name."""
    s, b = _words(small), _words(big)
    return 0 < len(s) < len(b) and any(b[i:i + len(s)] == s for i in range(len(b) - len(s) + 1))


def merge_allowed(label: str, into: str, page_counts: Mapping[str, int], into_existing: bool) -> bool:
    """The size and name rules for moving ``label`` into ``into``.

    The size rule holds only between two new labels: a compile never
    renames the wiki's labels, so a new label joins an existing one that
    names the same category whatever their pages.
    """
    pages, into_pages = page_counts.get(label), page_counts.get(into)
    if not into_existing and pages is not None and into_pages is not None and pages > into_pages:
        return False
    if _inside(into, label):
        return False
    if into_existing and len(_parts(into)) > 1 and _inside(label, into):
        # Drafts name one field per label; an old combined label may join
        # two fields ("Design & Accessibility"), which names cannot show,
        # so a label inside its name stays as it is.
        return False
    if _inside(label, into):
        is_part = len(_parts(into)) > 1 and tuple(_words(label)) in _parts(into)
        return is_part or (pages is not None and pages <= SMALL_LABEL_PAGES)
    return True


def clean_label_merges(
    merges: Iterable[_Merge],
    existing_labels: list[str],
    new_labels: list[str],
    page_counts: Mapping[str, int] | None = None,
) -> list[dict[str, str]]:
    """Merges as {label, into, reason}, in the order of ``new_labels``.

    ``page_counts`` maps a label, spelled as sent, to its pages.
    """
    counts = page_counts or {}
    spell_existing = _speller(existing_labels)
    spell_new = _speller(new_labels)
    target: dict[str, str] = {}
    reason: dict[str, str] = {}

    def end_of(name: str) -> str:
        seen = set()
        while name in target and name not in seen:
            seen.add(name)
            name = target[name]
        return name

    for m in merges:
        label_old, into_old = spell_existing(m.label), spell_existing(m.into)
        label_new = None if label_old else spell_new(m.label)
        into_new = spell_new(m.into)
        if label_new and (into_old or into_new):
            label, into, into_existing = label_new, into_old or into_new, into_old is not None
        elif label_old and into_new and not into_old:
            # The model named the wiki's label first: the new one moves.
            label, into, into_existing = into_new, label_old, True
        else:
            continue
        if label == into or label in target or end_of(into) == label:
            continue
        if not merge_allowed(label, into, counts, into_existing):
            continue
        target[label] = into
        reason[label] = m.reason

    return [
        {"label": n, "into": end_of(n), "reason": reason[n]}
        for n in dict.fromkeys(new_labels)
        if n in target
    ]
