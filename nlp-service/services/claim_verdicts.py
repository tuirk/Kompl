"""Settle the claim judge's answers (plan 3.3 and 3.6).

llm_client.judge_claim_pairs returns what the model said; this module keeps
what the app may store:

  - an answer for a pair that was sent, once (the first answer wins);
  - a verdict from CLAIM_VERDICTS, compared without case or spacing; any
    other answer is no verdict, so the pair stays unjudged and a later run
    asks again;
  - "outdated" only when the sources' dates order the two claims (owner
    decision D5: outdated vs disputed is decided by publication dates). An
    outdated claim with no provable order is "disputed".

`newer` names the side whose source is provably later ("a", "b"), for an
outdated verdict only; the other side is the superseded claim.

Pure functions: no I/O, no database (rule #1 in CLAUDE.md).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, Optional

from .llm_client import CLAIM_VERDICTS, ClaimJudgement

_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

Side = Literal["a", "b"]


@dataclass(frozen=True)
class SettledVerdict:
    pair_id: str
    verdict: str
    topic: str
    reason: str
    newer: Optional[Side]


def _day(side: dict[str, Any]) -> Optional[str]:
    date = side.get("date")
    return date if isinstance(date, str) and _ISO_DAY.match(date) else None


def newer_side(a: dict[str, Any], b: dict[str, Any]) -> Optional[Side]:
    """The side whose source is provably later, or None.

    A publication date is exact; a saved date only bounds the publication
    date from above (a source is published on or before the day it is
    saved). So one side is provably later only when it has a publication
    date and the other side's date, of either kind, is earlier.
    """
    day_a, day_b = _day(a), _day(b)
    if day_a is None or day_b is None:
        return None
    if b.get("date_kind") == "published" and day_a < day_b:
        return "b"
    if a.get("date_kind") == "published" and day_b < day_a:
        return "a"
    return None


def settle_judgements(
    pairs: list[dict[str, Any]],
    judgements: list[ClaimJudgement],
) -> list[SettledVerdict]:
    """One settled verdict per answered pair, in the order the pairs were sent."""
    by_id = {pair["pair_id"]: pair for pair in pairs}
    settled: dict[str, SettledVerdict] = {}
    for j in judgements:
        pair = by_id.get(j.pair_id.strip())
        if pair is None or pair["pair_id"] in settled:
            continue
        verdict = j.verdict.strip().lower()
        if verdict not in CLAIM_VERDICTS:
            continue
        newer: Optional[Side] = None
        if verdict == "outdated":
            newer = newer_side(pair["a"], pair["b"])
            if newer is None:
                verdict = "disputed"
        settled[pair["pair_id"]] = SettledVerdict(
            pair_id=pair["pair_id"],
            verdict=verdict,
            topic=j.topic.strip(),
            reason=j.reason.strip(),
            newer=newer,
        )
    return [settled[p["pair_id"]] for p in pairs if p["pair_id"] in settled]
