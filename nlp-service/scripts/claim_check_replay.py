"""Replay gate for the claim check (plan 3.7, decision D3).

Sends the labelled claim pairs in claim_check_replay_pairs.json to the claim
judge of a running nlp-service, then prints how often each verdict is right
(precision) and how many of each kind it finds (recall), per kind and for
"flagged" (disputed or outdated: what the check shows the owner as a
possible disagreement), and every wrong verdict with the label's reason.
The claim check is turned on by default only after runs on each compile
model meet the bar the owner agrees (BAR below holds the proposal).

Usage, from the repo root, with nlp-service up (docker compose publishes it
on 127.0.0.1:8000) and the model's API key set in its environment:

    python nlp-service/scripts/claim_check_replay.py --model deepseek-flash --save deepseek-1.json
    # a second run, to see how much the verdicts move between runs:
    python nlp-service/scripts/claim_check_replay.py --model deepseek-flash --save deepseek-2.json \
        --compare deepseek-1.json
    # and the same pair of runs with --model gemini-2.5-flash

Options:
    --base-url URL   nlp-service address (default http://127.0.0.1:8000)
    --model ID       compile model, one of the service's allowlist
    --route PATH     the judge's route (default /pipeline/judge-claims)
    --batch N        pairs per request (default 8, the route's maximum)
    --swap           also judge every pair with its two sides swapped and
                     list the verdicts that change (doubles the LLM calls)
    --save PATH      write the results as JSON
    --compare PATH   print the verdicts that changed against a saved run

Exit code 0 when the run meets BAR, 1 when it does not.

The request and response shapes are in to_request() and from_results();
keep them in step with the judge's route. Cost: about 30 pairs in a few
small LLM batches per run (cents), counted toward the service's daily cost
cap. Nothing here touches the wiki database: nlp-service never opens it.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PAIRS = Path(__file__).with_name("claim_check_replay_pairs.json")
KINDS = ("disputed", "outdated", "scope", "opinion", "none")
FLAGGED = {"disputed", "outdated"}  # shown to the owner as a possible disagreement

# Proposed bar (plan 3.7, D3), to be agreed with the owner. On the vetted
# set's 10 real disagreements (5 disputed, 5 outdated):
#   flag_precision  of the pairs the judge flags, at least 9 in 10 are real:
#                   at most 1 false alarm when it flags all 10
#   none_flagged    it never flags two sources that agree
#   flag_recall     it finds at least 7 of the 10
#   kind_right      of those it finds, at least 8 in 10 get the right kind
#                   (disagree vs updated)
BAR = {"flag_precision": 0.9, "none_flagged": 0, "flag_recall": 0.7, "kind_right": 0.8}


def post(base_url: str, path: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(base_url.rstrip("/") + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{path} answered {e.code}: {e.read().decode('utf-8', 'replace')[:500]}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"cannot reach nlp-service at {base_url}: {e.reason}") from e


# ---------------------------------------------------------------------------
# The judge's contract
# ---------------------------------------------------------------------------


def _side(s: dict[str, Any]) -> dict[str, Any]:
    return {"claim": s["claim"], "quote": s["quote"], "source_title": s["source"],
            "date": s["date"], "date_kind": s["date_kind"]}


def to_request(item: dict[str, Any], swap: bool = False) -> dict[str, Any]:
    """One pair as the judge takes it: both claims with their quotes, their
    sources' titles and dates ("saved" when the publication date is unknown)."""
    a, b = (item["b"], item["a"]) if swap else (item["a"], item["b"])
    return {"pair_id": item["id"], "subject": item["subject"], "a": _side(a), "b": _side(b)}


def from_results(resp: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The judge's answer by pair_id: its verdict (the kind) and reason.
    /pipeline/judge-claims answers {items: [{pair_id, verdict, reason, ...}], count};
    a pair it left out stays unanswered and counts as wrong."""
    return {str(r["pair_id"]): {"kind": r.get("verdict"), "reason": r.get("reason")}
            for r in resp["items"] if r.get("pair_id") is not None}


def judge(items: list[dict[str, Any]], base_url: str, route: str, model: str, batch: int,
          swap: bool = False) -> list[dict[str, Any]]:
    """Every item's verdict. A pair the judge leaves out reads as "missing"
    and an answer outside KINDS as "invalid"; both count as wrong and as
    not flagged."""
    answers: dict[str, dict[str, Any]] = {}
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        body = {"pairs": [to_request(i, swap) for i in chunk], "compile_model": model}
        answers.update(from_results(post(base_url, route, body, 900)))
    out = []
    for item in items:
        answer = answers.get(item["id"])
        if answer is None:
            got = "missing"
        else:
            got = answer["kind"] if answer["kind"] in KINDS else "invalid"
        out.append({"id": item["id"], "expected": item["kind"], "origin": item["origin"],
                    "confidence": item.get("confidence", "high"), "got": got,
                    "answer": answer and {"kind": answer["kind"], "reason": answer["reason"]}})
    return out


# ---------------------------------------------------------------------------
# Scores and the bar
# ---------------------------------------------------------------------------


def _ratio(n: int, d: int) -> float | None:
    return n / d if d else None


def scores(results: list[dict[str, Any]]) -> dict[str, Any]:
    per_kind = {}
    for kind in KINDS:
        tp = sum(r["expected"] == kind and r["got"] == kind for r in results)
        fp = sum(r["expected"] != kind and r["got"] == kind for r in results)
        fn = sum(r["expected"] == kind and r["got"] != kind for r in results)
        per_kind[kind] = {"tp": tp, "fp": fp, "fn": fn, "precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn)}
    flag_tp = sum(r["expected"] in FLAGGED and r["got"] in FLAGGED for r in results)
    flag_fp = sum(r["expected"] not in FLAGGED and r["got"] in FLAGGED for r in results)
    flag_fn = sum(r["expected"] in FLAGGED and r["got"] not in FLAGGED for r in results)
    kind_right = sum(r["expected"] in FLAGGED and r["got"] == r["expected"] for r in results)
    return {
        "pairs": len(results),
        "exact": sum(r["got"] == r["expected"] for r in results),
        "per_kind": per_kind,
        "flagged": {"tp": flag_tp, "fp": flag_fp, "fn": flag_fn,
                    "precision": _ratio(flag_tp, flag_tp + flag_fp), "recall": _ratio(flag_tp, flag_tp + flag_fn)},
        "none_flagged": sum(r["expected"] == "none" and r["got"] in FLAGGED for r in results),
        "kind_right": {"right": kind_right, "of": flag_tp, "share": _ratio(kind_right, flag_tp)},
    }


def bar_failures(s: dict[str, Any], bar: dict[str, Any] = BAR) -> list[str]:
    """What keeps the run under the bar, in plain words; empty when it passes."""
    out = []
    f = s["flagged"]
    if f["precision"] is None:
        out.append("it flagged no pair at all")
    elif f["precision"] < bar["flag_precision"]:
        out.append(f"{f['fp']} of its {f['tp'] + f['fp']} flags are false alarms "
                   f"(precision {pct(f['precision'])}, bar {pct(bar['flag_precision'])})")
    if s["none_flagged"] > bar["none_flagged"]:
        out.append(f"it flagged {s['none_flagged']} pair(s) of sources that agree")
    if f["recall"] is not None and f["recall"] < bar["flag_recall"]:
        out.append(f"it found {f['tp']} of {f['tp'] + f['fn']} real disagreements "
                   f"(recall {pct(f['recall'])}, bar {pct(bar['flag_recall'])})")
    k = s["kind_right"]
    if k["share"] is not None and k["share"] < bar["kind_right"]:
        out.append(f"it named the kind right on {k['right']} of the {k['of']} it found "
                   f"({pct(k['share'])}, bar {pct(bar['kind_right'])})")
    return out


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def report(items: list[dict[str, Any]], results: list[dict[str, Any]], s: dict[str, Any]) -> None:
    print(f"\n{'kind':<10}{'precision':>10}{'recall':>9}   tp fp fn")
    for kind, k in s["per_kind"].items():
        print(f"{kind:<10}{pct(k['precision']):>10}{pct(k['recall']):>9}   {k['tp']:>2} {k['fp']:>2} {k['fn']:>2}")
    f = s["flagged"]
    print(f"{'flagged':<10}{pct(f['precision']):>10}{pct(f['recall']):>9}   {f['tp']:>2} {f['fp']:>2} {f['fn']:>2}"
          "   (disputed or outdated, kind aside)")
    real = scores([r for r in results if r["origin"] == "real"])["flagged"]
    print(f"real pairs only: flagged precision {pct(real['precision'])}, recall {pct(real['recall'])}")
    print(f"exact verdicts {s['exact']}/{s['pairs']} · kind right on {s['kind_right']['right']}/{s['kind_right']['of']} "
          f"found · agreeing pairs flagged {s['none_flagged']}")
    by_id = {i["id"]: i for i in items}
    for r in results:
        if r["got"] == r["expected"]:
            continue
        item = by_id[r["id"]]
        tags = [t for t, on in (("label to vet", r["confidence"] == "low"), ("synthetic", r["origin"] == "synthetic")) if on]
        print(f"\nWRONG {r['id']}: expected {r['expected']}, got {r['got']}{''.join(f' [{t}]' for t in tags)}")
        for name in ("a", "b"):
            side = item[name]
            print(f"  {name.upper()}: \"{side['quote']}\" ({side['source']}, {side['date_kind']} {side['date']})")
        print(f"  label: {item['why']}")
        if r["answer"] and r["answer"]["reason"]:
            print(f"  judge: {r['answer']['reason']}")


def main(argv: list[str] | None = None) -> int:
    # A Windows console defaults to cp1252, which can't print the quotes' dashes.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--model", required=True)
    ap.add_argument("--route", default="/pipeline/judge-claims")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--swap", action="store_true")
    ap.add_argument("--save", type=Path)
    ap.add_argument("--compare", type=Path)
    args = ap.parse_args(argv)
    if args.batch < 1:
        ap.error("--batch must be at least 1")
    items = json.loads(PAIRS.read_text(encoding="utf-8"))["items"]

    results = judge(items, args.base_url, args.route, args.model, args.batch)
    for r in results:
        print(f"  {'ok ' if r['got'] == r['expected'] else 'BAD'} {r['id']}: {r['got']}"
              + ("" if r["got"] == r["expected"] else f" (expected {r['expected']})"))
    s = scores(results)
    print(f"\nmodel {args.model} · {s['pairs']} pairs")
    report(items, results, s)

    swapped: list[dict[str, str]] = []
    if args.swap:
        again = judge(items, args.base_url, args.route, args.model, args.batch, swap=True)
        swapped = [{"id": r["id"], "before": r["got"], "after": x["got"]}
                   for r, x in zip(results, again) if x["got"] != r["got"]]
        print(f"\nsides swapped: {len(items) - len(swapped)}/{len(items)} verdicts unchanged"
              + "".join(f"\n  {c['id']}: {c['before']} → {c['after']}" for c in swapped))

    if args.compare:
        old = json.loads(args.compare.read_text(encoding="utf-8"))
        before = {r["id"]: r for r in old["results"]}
        o, f = old["scores"]["flagged"], s["flagged"]
        print(f"\nagainst {args.compare.name} (model {old['model']}): flagged precision {pct(o['precision'])} → "
              f"{pct(f['precision'])}, recall {pct(o['recall'])} → {pct(f['recall'])}")
        for r in results:
            if r["id"] in before and before[r["id"]]["got"] != r["got"]:
                print(f"  {r['id']}: {before[r['id']]['got']} → {r['got']} (expected {r['expected']})")

    failures = bar_failures(s)
    print("\nbar: " + ("PASS" if not failures else "FAIL\n" + "\n".join(f"  - {x}" for x in failures)))
    if args.save:
        args.save.write_text(json.dumps({"model": args.model, "base_url": args.base_url, "route": args.route,
                                         "scores": s, "results": results, "swapped_changes": swapped,
                                         "bar": BAR, "bar_failures": failures}, indent=2), encoding="utf-8")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
