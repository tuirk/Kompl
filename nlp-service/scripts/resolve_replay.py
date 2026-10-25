"""Replay gate for entity resolution (decision 2026-10-23, item 1).

Runs the labelled name pairs in resolve_replay_pairs.json through the real
/resolve/fuzzy, /resolve/embedding and /resolve/disambiguate endpoints of a
running nlp-service, folds the verdicts the way /api/compile/resolve does,
and prints the precision and recall of "same" plus every wrong verdict.
Run it on the build before a resolver change and on the build after, on
each model, and compare: the change ships only if precision does not drop.

Each item is one small compile session: the two names under test, any other
names the session holds (the "PM" between "Product Manager" and "Project
Manager"), existing page titles and stored aliases. A side bound to a page goes
to Layer 3 with the page's summary and stored aliases, as the route sends it.

Usage, from the repo root, with nlp-service up (docker compose publishes it
on 127.0.0.1:8000) and the model's API key set in its environment:

    python nlp-service/scripts/resolve_replay.py --model deepseek-flash --save before-deepseek.json
    # rebuild nlp-service with the change, then:
    python nlp-service/scripts/resolve_replay.py --model deepseek-flash --save after-deepseek.json \
        --compare before-deepseek.json
    # and the same pair of runs with --model gemini-2.5-flash

Options:
    --base-url URL   nlp-service address (default http://127.0.0.1:8000)
    --model ID       compile model for Layer 3, one of the service's allowlist
    --no-llm         Layers 1 and 2 only, free: what merges, what is asked,
                     what is never asked
    --shuffles N     input-order check: each session through Layers 1 and 2
                     in N shuffled orders (default 3; 0 to skip), which must
                     give the same groups and pairs
    --shuffle-llm    also re-run the full verdict once on a shuffled order
                     (doubles the LLM calls)
    --save PATH      write the results as JSON
    --compare PATH   print the verdicts that changed against a saved run

Cost: one /resolve/disambiguate request per item that has ambiguous pairs,
a handful of small LLM batches per run (cents). The calls count toward the
service's daily cost cap. Nothing here touches the wiki database: nlp-service
never opens it.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PAIRS = Path(__file__).with_name("resolve_replay_pairs.json")
ANCHORED = {"existing_page_title", "existing_alias"}  # resolution.py _ANCHORED_METHODS
PAGE = "__existing_page__"                           # resolution.py EXISTING_PAGE_SENTINEL
GROUP = "__group__:"                                 # resolution.py GROUP_SENTINEL_PREFIX
MAX_KNOWN_NAMES = 10                                 # lib/resolve-page-sides.ts MAX_KNOWN_NAMES


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


def session(item: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """The item's session names, existing page titles and stored aliases."""
    sides = [item["a"], item["b"], *item.get("others", [])]
    entities = [{"name": s["name"], "type": s["type"], "source_id": s["source"], "context": s.get("context", "")}
                for s in sides if not s.get("page")]
    # With its summary when the item gives one, as the route sends it (closest by meaning).
    pages = [{"title": p["title"], "page_type": p["page_type"], **({"summary": p["summary"]} if p.get("summary") else {})}
             for p in [*item.get("pages", []),
                       *({"title": s["name"], "page_type": s["page_type"], "summary": s.get("summary")}
                         for s in sides if s.get("page"))]]
    return entities, pages, list(item.get("aliases", []))


def group_context(group: dict[str, Any], entities: list[dict[str, Any]]) -> str:
    """The route's groupContext: a context of one of the group's own names,
    the canonical spelling first. The route's pool comes in extraction
    order (created_at, then source); here by source, so the input-order
    check never changes which context a group carries."""
    names = {n.lower() for n in [group["canonical"], *group["aliases"]]}
    own = sorted((e for e in entities if e["context"] and e["source_id"] in group["source_ids"]
                  and e["name"].lower() in names), key=lambda e: e["source_id"])
    first = next((e for e in own if e["name"].lower() == group["canonical"].lower()), own[0] if own else None)
    return first["context"] if first else ""


def page_sides(item: dict[str, Any], groups: list[dict[str, Any]],
               pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The pairs as the route sends them to Layer 3 (lib/resolve-page-sides.ts):
    a side bound to a page (the page, or a group bound to it) goes with the
    page's summary as its context and the page's stored aliases as
    known_names."""
    summaries = {pt["title"].lower(): pt.get("summary", "") for pt in item.get("pages", [])}
    summaries.update({s["name"].lower(): s.get("summary", "")
                      for s in (item["a"], item["b"], *item.get("others", [])) if s.get("page")})
    known: dict[str, list[str]] = {}
    for a in item.get("aliases", []):
        names = known.setdefault(a["canonical"].lower(), [])
        if a["alias"].lower() != a["canonical"].lower() and a["alias"].lower() not in {n.lower() for n in names}:
            names.append(a["alias"])

    def side(e: dict[str, Any]) -> dict[str, Any]:
        if e["source_id"] == PAGE:
            title = e["name"]
        elif e["source_id"].startswith(GROUP) and groups[int(e["source_id"][len(GROUP):])]["method"] in ANCHORED:
            title = groups[int(e["source_id"][len(GROUP):])]["canonical"]
        else:
            return e
        return {**e, "context": summaries.get(title.lower()) or e["context"],
                "known_names": known.get(title.lower(), [])[:MAX_KNOWN_NAMES]}

    return [{**p, "entity_a": side(p["entity_a"]), "entity_b": side(p["entity_b"])} for p in pairs]


def layers_1_2(base_url: str, entities: list[dict[str, Any]], pages: list[dict[str, Any]],
               aliases: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    fuzzy = post(base_url, "/resolve/fuzzy",
                 {"entities": entities, "existing_aliases": aliases, "existing_page_titles": pages}, 120)
    groups = [{**g, "context": group_context(g, entities)} for g in fuzzy["resolved"]]
    emb = post(base_url, "/resolve/embedding",
               {"entities": fuzzy["unresolved"], "groups": groups, "existing_page_titles": pages}, 600)
    return fuzzy, emb


# ---------------------------------------------------------------------------
# Folding verdicts as the route does
# ---------------------------------------------------------------------------


class _Union:
    def __init__(self) -> None:
        self.parent: dict[tuple[Any, ...], tuple[Any, ...]] = {}

    def find(self, x: tuple[Any, ...]) -> tuple[Any, ...]:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            x = self.parent[x]
        return x

    def pages(self, x: tuple[Any, ...]) -> set[str]:
        root = self.find(x)
        return {k[1] for k in list(self.parent) if k[0] == "page" and self.find(k) == root}

    def union(self, x: tuple[Any, ...], y: tuple[Any, ...]) -> bool:
        if len(self.pages(x) | self.pages(y)) > 1:
            return False  # two pages never join
        self.parent[self.find(x)] = self.find(y)
        return True


def label(e: dict[str, Any]) -> tuple[Any, ...]:
    """A side of an AmbiguousPair: a page, a group of the response, or a lone name."""
    if e["source_id"] == PAGE:
        return ("page", e["name"].lower())
    if e["source_id"].startswith(GROUP):
        return ("group", int(e["source_id"][len(GROUP):]))
    return ("entity", e["name"], e["source_id"])


def where(side: dict[str, Any], groups: list[dict[str, Any]]) -> tuple[Any, ...]:
    if side.get("page"):
        return ("page", side["name"].lower())
    for k, g in enumerate(groups):
        if side["source"] in g["source_ids"] and side["name"] in [g["canonical"], *g["aliases"]]:
            return ("group", k)
    return ("entity", side["name"], side["source"])


def fold(groups: list[dict[str, Any]], pairs: list[dict[str, Any]], verdicts: list[dict[str, Any] | None]) -> _Union:
    """Groups bound to a page hold it; then each 'same' verdict joins its two
    sides, verdicts touching the wiki first, a lone name joining one group
    only and two pages never joining (route.ts applySame)."""
    u = _Union()
    for k, g in enumerate(groups):
        if g["method"] in ANCHORED:
            u.union(("group", k), ("page", g["canonical"].lower()))

    def touches_wiki(pair: dict[str, Any]) -> bool:
        sides = [label(pair["entity_a"]), label(pair["entity_b"])]
        return any(s[0] == "page" or (s[0] == "group" and groups[s[1]]["method"] in ANCHORED) for s in sides)

    order = sorted(range(len(pairs)), key=lambda k: not touches_wiki(pairs[k]))
    merged: set[tuple[Any, ...]] = set()
    for k in order:
        verdict = verdicts[k]
        if verdict is None or verdict["decision"] != "same":
            continue
        x, y = label(pairs[k]["entity_a"]), label(pairs[k]["entity_b"])
        lone = [s for s in (x, y) if s[0] == "entity"]
        if any(s in merged for s in lone):
            continue
        if u.union(x, y):
            merged.update(lone)
    return u


def judge(item: dict[str, Any], base_url: str, model: str | None, rng: random.Random | None = None) -> dict[str, Any]:
    """Runs one item; returns its verdict, the layer that decided it and the
    model's answer on the pair itself when it was asked."""
    entities, pages, aliases = session(item)
    if rng is not None:
        rng.shuffle(entities)
        rng.shuffle(pages)
    fuzzy, emb = layers_1_2(base_url, entities, pages, aliases)
    a, b = item["a"], item["b"]
    layer1 = fold(fuzzy["resolved"], [], [])
    if layer1.find(where(a, fuzzy["resolved"])) == layer1.find(where(b, fuzzy["resolved"])):
        return {"got": "same", "by": "layer 1", "answer": None}

    groups, pairs = emb["resolved"], emb["ambiguous"]
    la, lb = where(a, groups), where(b, groups)
    before_llm = fold(groups, [], [])
    if before_llm.find(la) == before_llm.find(lb):
        return {"got": "same", "by": "layer 2", "answer": None}
    # The pair between the two sides, a page side asked through the group bound to it.
    ends = {before_llm.find(la), before_llm.find(lb)}
    asked = next((p for p in pairs
                  if {before_llm.find(label(p["entity_a"])), before_llm.find(label(p["entity_b"]))} == ends), None)
    if model is None or not pairs:
        return {"got": "different", "by": "asked (no LLM run)" if asked else "never asked", "answer": None}

    sent = [{**p, "pair_id": str(k)} for k, p in enumerate(page_sides(item, groups, pairs))]
    resp = post(base_url, "/resolve/disambiguate", {"pairs": sent, "compile_model": model}, 3600)
    by_id = {r["pair_id"]: r for r in resp["results"] if r.get("pair_id") is not None}
    verdicts = [by_id.get(str(k)) for k in range(len(pairs))]
    after = fold(groups, pairs, verdicts)
    answer = by_id.get(str(pairs.index(asked))) if asked else None
    got = "same" if after.find(la) == after.find(lb) else "different"
    by = "layer 3" if asked else ("layer 3, through other names" if got == "same" else "never asked")
    return {"got": got, "by": by, "answer": answer and {k: answer[k] for k in ("decision", "canonical", "reason")}}


# ---------------------------------------------------------------------------
# Input-order check
# ---------------------------------------------------------------------------


def signature(fuzzy: dict[str, Any], emb: dict[str, Any]) -> str:
    """Layers 1 and 2 output with every order-only difference removed."""
    def grp(g: dict[str, Any]) -> list[Any]:
        return [g["canonical"], sorted(g["aliases"]), sorted(g["source_ids"]), g["method"], g["type"]]

    def side(e: dict[str, Any]) -> list[Any]:
        if e["source_id"].startswith(GROUP):
            g = emb["resolved"][int(e["source_id"][len(GROUP):])]
            return ["group", g["canonical"], sorted(g["source_ids"])]
        return [e["name"], e["type"], e["source_id"]]

    pairs = [[sorted([side(p["entity_a"]), side(p["entity_b"])]), round(p["similarity"], 3),
              round(p["name_similarity"], 3), p.get("same_source"), p.get("abbreviation")] for p in emb["ambiguous"]]
    return json.dumps({
        "fuzzy": [sorted(map(grp, fuzzy["resolved"])), sorted([e["name"], e["source_id"]] for e in fuzzy["unresolved"])],
        "embedding": [sorted(map(grp, emb["resolved"])), sorted(pairs),
                      sorted([e["name"], e["source_id"]] for e in emb["unresolved"])],
    }, sort_keys=True)


def shuffle_check(items: list[dict[str, Any]], base_url: str, shuffles: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    unstable = []
    for item in items:
        entities, pages, aliases = session(item)
        expected = signature(*layers_1_2(base_url, entities, pages, aliases))
        for _ in range(shuffles):
            rng.shuffle(entities)
            rng.shuffle(pages)
            if signature(*layers_1_2(base_url, entities, pages, aliases)) != expected:
                unstable.append(item["id"])
                break
    return unstable


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def scores(results: list[dict[str, Any]]) -> dict[str, Any]:
    tp = sum(r["expected"] == "same" and r["got"] == "same" for r in results)
    fp = sum(r["expected"] == "different" and r["got"] == "same" for r in results)
    fn = sum(r["expected"] == "same" and r["got"] == "different" for r in results)
    return {"tp": tp, "fp": fp, "fn": fn, "pairs": len(results),
            "precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None}


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def main(argv: list[str] | None = None) -> int:
    # A Windows console defaults to cp1252, which can't print the arrows below.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--model")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--shuffles", type=int, default=3)
    ap.add_argument("--shuffle-llm", action="store_true")
    ap.add_argument("--seed", type=int, default=20261023)
    ap.add_argument("--save", type=Path)
    ap.add_argument("--compare", type=Path)
    args = ap.parse_args(argv)
    if not args.no_llm and not args.model:
        ap.error("--model is required unless --no-llm")
    model = None if args.no_llm else args.model
    items = json.loads(PAIRS.read_text(encoding="utf-8"))["items"]

    results = []
    for item in items:
        r = {"id": item["id"], "expected": item["expected"], "confidence": item.get("confidence", "high"),
             **judge(item, args.base_url, model)}
        results.append(r)
        print(f"  {'ok ' if r['got'] == r['expected'] else 'BAD'} {r['id']}: {r['got']} ({r['by']})", flush=True)

    s = scores(results)
    print(f"\nmodel {model or '(no LLM)'} · {s['pairs']} pairs · precision {pct(s['precision'])} · "
          f"recall {pct(s['recall'])} · tp {s['tp']} fp {s['fp']} fn {s['fn']}")
    wrong = [r for r in results if r["got"] != r["expected"]]
    for r in wrong:
        item = next(i for i in items if i["id"] == r["id"])
        print(f"\nWRONG {r['id']}: expected {r['expected']}, got {r['got']} ({r['by']})"
              f"{' [label to vet]' if r['confidence'] == 'low' else ''}\n"
              f"  {item['a']['name']} / {item['b']['name']}: {item['why']}")
        if r["answer"]:
            print(f"  model: {r['answer']['decision']}: {r['answer']['reason']}")

    unstable: list[str] = []
    if args.shuffles > 0:
        unstable = shuffle_check(items, args.base_url, args.shuffles, args.seed)
        print(f"\ninput order: {len(items) - len(unstable)}/{len(items)} sessions give the same Layer 1 and 2 output"
              + (f"; differs: {', '.join(unstable)}" if unstable else ""))
    if args.shuffle_llm and model is not None:
        rng = random.Random(args.seed)
        flipped = [i["id"] for i, r in zip(items, results) if judge(i, args.base_url, model, rng)["got"] != r["got"]]
        print(f"verdicts on a shuffled order: {len(items) - len(flipped)}/{len(items)} unchanged"
              + (f"; changed: {', '.join(flipped)}" if flipped else ""))

    if args.compare:
        old = json.loads(args.compare.read_text(encoding="utf-8"))
        before = {r["id"]: r for r in old["results"]}
        print(f"\nagainst {args.compare.name} (model {old['model']}): precision {pct(old['scores']['precision'])} → "
              f"{pct(s['precision'])}, recall {pct(old['scores']['recall'])} → {pct(s['recall'])}")
        for r in results:
            if r["id"] in before and before[r["id"]]["got"] != r["got"]:
                print(f"  {r['id']}: {before[r['id']]['got']} → {r['got']} (expected {r['expected']})")
    if args.save:
        args.save.write_text(json.dumps({"model": model, "base_url": args.base_url, "scores": s, "results": results,
                                         "input_order_differs": unstable}, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
