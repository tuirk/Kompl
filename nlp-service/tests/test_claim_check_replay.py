"""The claim-check replay gate (scripts/claim_check_replay.py) and its
labelled pairs.

The harness runs against a live nlp-service and a real model; here it runs
in-process against a fake judge that answers from a fixed table, so its
requests, scoring and bar stay right as the pair set grows. Once the judge's
route is on this branch, mount it here with a fake model in place of
_fake_route, as tests/test_resolve_replay.py does for the resolver.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
ITEMS = json.loads((SCRIPTS / "claim_check_replay_pairs.json").read_text(encoding="utf-8"))["items"]
KINDS = {"disputed", "outdated", "scope", "opinion", "none"}


def _load_replay():
    spec = importlib.util.spec_from_file_location("claim_check_replay", SCRIPTS / "claim_check_replay.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_pair_set_is_labelled():
    assert 25 <= len(ITEMS) <= 40
    assert len({i["id"] for i in ITEMS}) == len(ITEMS)
    for item in ITEMS:
        assert item["kind"] in KINDS, item["id"]
        assert item["origin"] in {"real", "synthetic"}, item["id"]
        assert item["why"].strip() and item["subject"].strip(), item["id"]
        assert item.get("confidence", "high") in {"high", "low"}, item["id"]
        for side in (item["a"], item["b"]):
            assert side["claim"].strip() and side["quote"].strip() and side["source"].strip(), item["id"]
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", side["date"]), item["id"]
            assert side["date_kind"] in {"published", "saved"}, item["id"]
        assert item["a"]["source"] != item["b"]["source"], item["id"]
    kinds = [i["kind"] for i in ITEMS]
    assert set(kinds) == KINDS
    assert kinds.count("none") >= 5


def test_the_owner_vetted_the_set():
    """D3: the bar is measured on an example set the owner vetted (2026-10-24);
    a pair added since carries "confidence": "low" until she has looked."""
    pairs = json.loads((SCRIPTS / "claim_check_replay_pairs.json").read_text(encoding="utf-8"))
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", pairs["vetted_by_owner"])
    assert "catan-player-count" not in {i["id"] for i in ITEMS}  # dropped by the owner: the 5-6 player expansion
    assert sum(i["kind"] in {"disputed", "outdated"} for i in ITEMS) == 10
    assert sum(i["origin"] == "real" for i in ITEMS) > 2 * sum(i["origin"] == "synthetic" for i in ITEMS)


def test_an_outdated_pair_has_two_publication_dates():
    """D5: outdated against disputed is told by the sources' dates, so every
    'outdated' label rests on two different publication dates."""
    for item in ITEMS:
        if item["kind"] == "outdated":
            assert {item["a"]["date_kind"], item["b"]["date_kind"]} == {"published"}, item["id"]
            assert item["a"]["date"] != item["b"]["date"], item["id"]


def test_the_service_code_holds_no_replay_pair():
    """Examples in the judge's prompt would teach the replay its answers."""
    for path in [*(ROOT / "services").glob("*.py"), *(ROOT / "routers").glob("*.py")]:
        text = path.read_text(encoding="utf-8")
        for item in ITEMS:
            assert not (item["a"]["quote"] in text and item["b"]["quote"] in text), (path.name, item["id"])


def _fake_route(table: dict[str, str], dropped: set[str] = frozenset()):
    calls: list[dict[str, Any]] = []

    def post(_base_url: str, path: str, body: dict[str, Any], _timeout: float) -> dict[str, Any]:
        calls.append({"path": path, "body": body})
        items = [{"pair_id": p["pair_id"], "verdict": table[p["pair_id"]], "reason": "fake"}
                 for p in body["pairs"] if p["pair_id"] not in dropped]
        return {"items": items, "count": len(items)}

    return post, calls


@pytest.fixture
def replay(monkeypatch):
    module = _load_replay()
    table = {i["id"]: i["kind"] for i in ITEMS}
    post, calls = _fake_route(table)
    monkeypatch.setattr(module, "post", post)
    return module, table, calls


def test_requests_carry_both_sides_and_the_model_in_batches(replay):
    module, _table, calls = replay
    results = module.judge(ITEMS, "http://x", "/pipeline/judge-claims", "deepseek-flash", 7)
    assert [r["got"] for r in results] == [i["kind"] for i in ITEMS]
    n = len(ITEMS)
    assert [len(c["body"]["pairs"]) for c in calls] == [7] * (n // 7) + ([n % 7] if n % 7 else [])
    assert {c["path"] for c in calls} == {"/pipeline/judge-claims"}
    assert {c["body"]["compile_model"] for c in calls} == {"deepseek-flash"}
    first = calls[0]["body"]["pairs"][0]
    item = ITEMS[0]
    assert first == {"pair_id": item["id"], "subject": item["subject"],
                     "a": {"claim": item["a"]["claim"], "quote": item["a"]["quote"], "source_title": item["a"]["source"],
                           "date": item["a"]["date"], "date_kind": item["a"]["date_kind"]},
                     "b": {"claim": item["b"]["claim"], "quote": item["b"]["quote"], "source_title": item["b"]["source"],
                           "date": item["b"]["date"], "date_kind": item["b"]["date_kind"]}}


def test_swap_sends_the_sides_the_other_way_round(replay):
    module, _table, calls = replay
    module.judge(ITEMS[:1], "http://x", "/pipeline/judge-claims", "deepseek-flash", 10, swap=True)
    sent = calls[0]["body"]["pairs"][0]
    assert (sent["a"]["quote"], sent["b"]["quote"]) == (ITEMS[0]["b"]["quote"], ITEMS[0]["a"]["quote"])


def test_a_missing_or_unknown_verdict_counts_as_wrong_and_unflagged(monkeypatch):
    module = _load_replay()
    items = [i for i in ITEMS if i["kind"] == "disputed"][:2]
    post, _calls = _fake_route({items[0]["id"]: "contradiction", items[1]["id"]: "disputed"}, dropped={items[1]["id"]})
    monkeypatch.setattr(module, "post", post)
    results = module.judge(items, "http://x", "/pipeline/judge-claims", "m", 10)
    assert [r["got"] for r in results] == ["invalid", "missing"]
    assert module.scores(results)["flagged"] == {"tp": 0, "fp": 0, "fn": 2, "precision": None, "recall": 0.0}


def _r(expected: str, got: str, origin: str = "real") -> dict[str, Any]:
    return {"id": f"{expected}-{got}", "expected": expected, "got": got, "origin": origin}


def test_scores_per_kind_and_for_flagged_pairs(replay):
    module, _table, _calls = replay
    results = [_r("disputed", "disputed"), _r("disputed", "outdated"), _r("outdated", "outdated"),
               _r("outdated", "none"), _r("scope", "disputed"), _r("opinion", "scope"), _r("none", "none")]
    s = module.scores(results)
    assert s["per_kind"]["disputed"] == {"tp": 1, "fp": 1, "fn": 1, "precision": 0.5, "recall": 0.5}
    assert s["per_kind"]["outdated"] == {"tp": 1, "fp": 1, "fn": 1, "precision": 0.5, "recall": 0.5}
    assert s["per_kind"]["opinion"] == {"tp": 0, "fp": 0, "fn": 1, "precision": None, "recall": 0.0}
    assert s["flagged"] == {"tp": 3, "fp": 1, "fn": 1, "precision": 0.75, "recall": 0.75}
    assert s["kind_right"] == {"right": 2, "of": 3, "share": 2 / 3}
    assert (s["exact"], s["none_flagged"], s["pairs"]) == (3, 0, 7)


def test_the_bar(replay):
    module, _table, _calls = replay
    perfect = [_r(i["kind"], i["kind"]) for i in ITEMS]
    assert module.bar_failures(module.scores(perfect)) == []
    one_false_alarm = [*perfect, _r("none", "disputed")]
    failures = module.bar_failures(module.scores(one_false_alarm))
    assert failures == ["it flagged 1 pair(s) of sources that agree"]
    silent = [_r(i["kind"], "none") for i in ITEMS]
    assert module.bar_failures(module.scores(silent)) == ["it flagged no pair at all",
                                                          "it found 0 of 10 real disagreements (recall 0.0%, bar 70.0%)"]
    clashes = [i["id"] for i in ITEMS if i["kind"] in {"disputed", "outdated"}]

    def missing(ids: list[str]) -> list[dict[str, Any]]:
        return [_r(i["kind"], "none" if i["id"] in ids else i["kind"]) for i in ITEMS]

    assert module.bar_failures(module.scores(missing(clashes[:3]))) == []  # 7 of 10 found
    assert module.bar_failures(module.scores(missing(clashes[:4]))) == [
        "it found 6 of 10 real disagreements (recall 60.0%, bar 70.0%)"]
    muddled = [_r(i["kind"], "disputed" if i["kind"] in {"disputed", "outdated"} else i["kind"]) for i in ITEMS]
    assert module.bar_failures(module.scores(muddled)) == [
        "it named the kind right on 5 of the 10 it found (50.0%, bar 80.0%)"]


def test_main_reports_saves_and_compares(replay, monkeypatch, tmp_path, capsys):
    module, table, _calls = replay
    before = tmp_path / "before.json"
    assert module.main(["--model", "deepseek-flash", "--save", str(before)]) == 0
    saved = json.loads(before.read_text(encoding="utf-8"))
    assert saved["bar_failures"] == [] and saved["scores"]["exact"] == len(ITEMS)
    assert "bar: PASS" in capsys.readouterr().out

    # The judge now calls the depth pair "outdated" and an agreeing pair "disputed".
    post, _ = _fake_route({**table, "lake-galve-maximum-depth": "outdated", "kaunas-cheaper": "disputed"})
    monkeypatch.setattr(module, "post", post)
    assert module.main(["--model", "deepseek-flash", "--compare", str(before), "--swap"]) == 1
    out = capsys.readouterr().out
    assert "WRONG lake-galve-maximum-depth: expected disputed, got outdated" in out
    assert "WRONG kaunas-cheaper: expected none, got disputed" in out
    assert "  label: Both say Kaunas is the cheaper city." in out
    assert "  judge: fake" in out
    assert "kaunas-cheaper: none → disputed (expected none)" in out
    assert f"sides swapped: {len(ITEMS)}/{len(ITEMS)} verdicts unchanged" in out
    assert "bar: FAIL" in out and "it flagged 1 pair(s) of sources that agree" in out
