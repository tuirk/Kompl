"""The replay gate harness (scripts/resolve_replay.py) and its labelled pairs.

The harness runs against a live nlp-service and a real model; here it runs
against the router in-process, with a fake encoder and a fake model, so its
folding and scoring stay right as the resolver changes.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
ITEMS = json.loads((SCRIPTS / "resolve_replay_pairs.json").read_text(encoding="utf-8"))["items"]


def _load_replay():
    spec = importlib.util.spec_from_file_location("resolve_replay", SCRIPTS / "resolve_replay.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_pair_set_is_labelled():
    assert 20 <= len(ITEMS) <= 40
    assert len({i["id"] for i in ITEMS}) == len(ITEMS)
    for item in ITEMS:
        assert item["expected"] in {"same", "different"}, item["id"]
        assert item["why"].strip(), item["id"]
        for side in (item["a"], item["b"], *item.get("others", [])):
            assert side.get("page") or {"name", "type", "source", "context"} <= set(side), item["id"]
    assert {i["expected"] for i in ITEMS} == {"same", "different"}


def test_the_layer_3_prompts_hold_no_replay_pair():
    """Examples in the prompts would teach the replay its answers."""
    from services import llm_client  # noqa: PLC0415

    for prompt in (llm_client._DISAMBIGUATION_SYSTEM_PROMPT, llm_client._DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT,
                   llm_client._DISAMBIGUATION_PAGE_SYSTEM_PROMPT, llm_client._DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT):
        for item in ITEMS:
            assert not (f'"{item["a"]["name"]}"' in prompt and f'"{item["b"]["name"]}"' in prompt), item["id"]


class _Encoder:
    """Every text on one axis except names listed as unlike."""

    def __init__(self, unlike: set[str]):
        self.unlike = unlike

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        out = []
        for k, t in enumerate(texts):
            v = [0.0] * 64
            v[k % 60 + 1 if t.split(":", 1)[0] in self.unlike else 0] = 1.0
            out.append(v)
        return np.array(out, dtype=np.float32)


@pytest.fixture
def replay(monkeypatch):
    from routers import resolution  # noqa: PLC0415
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse, DisambiguationResult  # noqa: PLC0415

    app = FastAPI()
    app.include_router(resolution.router)
    client = TestClient(app)
    module = _load_replay()
    calls: list[dict[str, Any]] = []

    def post(_base_url: str, path: str, body: dict[str, Any], _timeout: float) -> dict[str, Any]:
        calls.append({"path": path, "body": body})
        resp = client.post(path, json=body)
        assert resp.status_code == 200, resp.text
        return resp.json()

    def model(pairs, model, pair_kind="entity"):  # noqa: ARG001
        # Says "same" only to ML / Machine Learning and CI / Continuous Integration.
        same = {frozenset({"ML", "Machine Learning"}), frozenset({"CI", "Continuous Integration"})}
        return DisambiguationResponse(results=[
            DisambiguationResult(entity_a=p["entity_a"]["name"], entity_b=p["entity_b"]["name"],
                                 decision="same" if frozenset({p["entity_a"]["name"], p["entity_b"]["name"]}) in same
                                 else "different", canonical=None, reason="fake")
            for p in pairs
        ])

    monkeypatch.setattr(module, "post", post)
    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", model)
    monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Encoder({"Confidence Interval", "Project Manager"}))
    return module, calls


def _item(item_id: str) -> dict[str, Any]:
    return next(i for i in ITEMS if i["id"] == item_id)


def test_a_layer_1_merge_is_reported_as_layer_1(replay):
    module, _calls = replay
    assert module.judge(_item("gpt-4-spellings"), "http://x", "deepseek-flash") == \
        {"got": "same", "by": "layer 1", "answer": None}


def test_an_acronym_reaches_the_model_and_its_verdict_is_folded(replay):
    module, calls = replay
    result = module.judge(_item("ci-is-continuous-integration"), "http://x", "deepseek-flash")
    assert result["got"] == "same" and result["by"] == "layer 3"
    assert result["answer"]["decision"] == "same"
    sent = next(c for c in calls if c["path"] == "/resolve/disambiguate")["body"]
    assert sent["compile_model"] == "deepseek-flash"
    assert all("pair_id" in p for p in sent["pairs"])


def test_a_hub_does_not_chain_two_names_through_the_route_fold(replay, monkeypatch):
    """Even when the model calls "CI" the same as both expansions, the
    route lets a lone name join one group only."""
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse, DisambiguationResult  # noqa: PLC0415

    module, _calls = replay
    assert module.judge(_item("continuous-integration-vs-confidence-interval"), "http://x", "deepseek-flash")["got"] \
        == "different"
    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", lambda pairs, model, pair_kind="entity": (
        DisambiguationResponse(results=[DisambiguationResult(entity_a=p["entity_a"]["name"], entity_b=p["entity_b"]["name"],
                                                             decision="same", canonical=None, reason="fake")
                                        for p in pairs])))
    assert module.judge(_item("continuous-integration-vs-confidence-interval"), "http://x", "deepseek-flash")["got"] \
        == "different"


def test_without_the_model_it_reports_what_is_asked(replay):
    module, calls = replay
    result = module.judge(_item("ml-is-machine-learning"), "http://x", None)
    assert result == {"got": "different", "by": "asked (no LLM run)", "answer": None}
    assert all(c["path"] != "/resolve/disambiguate" for c in calls)


class _Far:
    """Every text unlike every other: what the rules ask whatever the similarity."""

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        out = np.zeros((len(texts), len(texts) + 1), dtype=np.float32)
        out[np.arange(len(texts)), np.arange(len(texts))] = 1.0
        return out


def test_a_longer_name_for_a_page_is_asked_against_it(replay, monkeypatch):
    """The model scores "APCA" / "APCA contrast algorithm" 0.53 by name and
    0.57 with contexts, under the 0.7 band; the pair is asked all the same,
    and a "same" verdict joins the name to the page."""
    from routers import resolution  # noqa: PLC0415
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse, DisambiguationResult  # noqa: PLC0415

    module, _calls = replay
    monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Encoder({"APCA contrast algorithm"}))
    item = _item("apca-page-vs-apca-contrast-algorithm")
    assert module.judge(item, "http://x", None) == {"got": "different", "by": "asked (no LLM run)", "answer": None}
    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", lambda pairs, model, pair_kind="entity": (
        DisambiguationResponse(results=[DisambiguationResult(entity_a=p["entity_a"]["name"], entity_b=p["entity_b"]["name"],
                                                             decision="same", canonical="APCA", reason="fake")
                                        for p in pairs])))
    result = module.judge(item, "http://x", "deepseek-flash")
    assert (result["got"], result["by"], result["answer"]["decision"]) == ("same", "layer 3", "same")


def test_a_ticker_is_asked_about(replay, monkeypatch):
    """"ETH" / "Ethereum" score 0.53 by name and 0.20 with contexts."""
    from routers import resolution  # noqa: PLC0415

    module, _calls = replay
    monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Encoder({"Ethereum"}))
    assert module.judge(_item("eth-is-ethereum"), "http://x", None) == \
        {"got": "different", "by": "asked (no LLM run)", "answer": None}


def test_what_the_rules_ask_whatever_the_similarity(replay, monkeypatch):
    """With no two texts alike, Layer 1 merges the spellings and Layer 3 is
    asked about the acronyms, the tickers, the one-letter slips and the
    names that add words to a page; every other pair is left to similarity."""
    from routers import resolution  # noqa: PLC0415

    module, _calls = replay
    monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Far())
    got = {item["id"]: module.judge(item, "http://x", None)["by"] for item in ITEMS}
    assert {k: v for k, v in got.items() if v != "never asked"} == {
        "pm-is-product-manager": "asked (no LLM run)",
        "ci-is-continuous-integration": "asked (no LLM run)",
        "ml-is-machine-learning": "asked (no LLM run)",
        "eth-is-ethereum": "asked (no LLM run)",
        "wikipedia-vs-wikimedia": "asked (no LLM run)",
        "apca-page-vs-apca-contrast-algorithm": "asked (no LLM run)",
        "karpathy-is-andrej-karpathy": "layer 1",
        "gpt-4-spellings": "layer 1",
        "llm-plural": "layer 1",
        "colorblindness-is-cvd-page-by-alias": "layer 1",
    }


def test_a_side_bound_to_a_page_reaches_the_model_as_that_page(replay, monkeypatch):
    """As the route sends it (lib/resolve-page-sides.ts): the group bound to
    the page "Color Vision Deficiency" goes with the page summary, not the
    source's "a broader term" sentence, and with the page's stored names."""
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse, DisambiguationResult  # noqa: PLC0415

    module, _calls = replay
    seen: list[dict[str, Any]] = []

    def model(pairs, model, pair_kind="entity"):  # noqa: ARG001
        seen.extend(pairs)
        return DisambiguationResponse(results=[
            DisambiguationResult(entity_a=p["entity_a"]["name"], entity_b=p["entity_b"]["name"], decision="same",
                                 canonical="Color Vision Deficiency", reason="fake")
            for p in pairs if "known_names" in p["entity_b"] or "known_names" in p["entity_a"]
        ])

    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", model)
    item = _item("colorblindness-is-cvd-page-by-summary")
    result = module.judge(item, "http://x", "deepseek-flash")
    assert (result["got"], result["by"]) == ("same", "layer 3")
    [page_side] = [s for p in seen for s in (p["entity_a"], p["entity_b"]) if "known_names" in s]
    assert page_side == {"name": "Color Vision Deficiency", "type": "CONCEPT", "context": item["b"]["summary"],
                         "known_names": []}

    seen.clear()
    module.judge(_item("deuteranopia-vs-cvd-page"), "http://x", "deepseek-flash")
    assert [s["known_names"] for p in seen for s in (p["entity_a"], p["entity_b"]) if "known_names" in s] ==         [["Colour-blindness"]]


class _Measured:
    """The item's name on axis 0, its "name: context" at cosine 0.6 with it,
    and each page title at the (name, context) cosines real MiniLM gave."""

    def __init__(self, name: str, context: str, titles: dict[str, tuple[float, float]]):
        self.vectors = {name: [1.0, 0.0, 0.0, 0.0, 0.0], f"{name}: {context}": [0.6, 0.8, 0.0, 0.0, 0.0]}
        for k, (title, (ns, cs)) in enumerate(titles.items()):
            v = [ns, (cs - 0.6 * ns) / 0.8, 0.0, 0.0, 0.0]
            v[2 + k] = (1 - v[0] ** 2 - v[1] ** 2) ** 0.5
            self.vectors[title] = v

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        return np.array([self.vectors.get(t, [0.0, 0.0, 0.0, 0.0, 1.0]) for t in texts], dtype=np.float32)


def test_a_concept_is_asked_about_the_entity_page_with_its_abbreviation_in_brackets(replay, monkeypatch):
    """Film run 2026-10-25: "Colorblindness" scored 0.5392 by name against
    the entity page "Color Vision Deficiency (CVD)" and only the name
    counted across kinds, so it was never asked. Without the bracket it
    scores 0.6829 by name and 0.7741 with context; the context asks."""
    from routers import resolution  # noqa: PLC0415
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse, DisambiguationResult  # noqa: PLC0415

    module, _calls = replay
    item = _item("colorblindness-vs-cvd-entity-page-parenthetical")
    monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Measured(item["a"]["name"], item["a"]["context"], {
        "Color Vision Deficiency": (0.6829, 0.7741), "Color Vision Deficiency (CVD)": (0.5392, 0.6355)}))
    assert module.judge(item, "http://x", None) == {"got": "different", "by": "asked (no LLM run)", "answer": None}

    seen: list[dict[str, Any]] = []

    def model(pairs, model, pair_kind="entity"):  # noqa: ARG001
        seen.extend(pairs)
        return DisambiguationResponse(results=[
            DisambiguationResult(entity_a=p["entity_a"]["name"], entity_b=p["entity_b"]["name"], decision="same",
                                 canonical="Color Vision Deficiency (CVD)", reason="fake") for p in pairs])

    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", model)
    result = module.judge(item, "http://x", "deepseek-flash")
    assert (result["got"], result["by"]) == ("same", "layer 3")
    [page_side] = [s for p in seen for s in (p["entity_a"], p["entity_b"]) if "known_names" in s]
    assert page_side == {"name": "Color Vision Deficiency (CVD)", "type": "OTHER", "context": item["b"]["summary"],
                         "known_names": ["Color vision deficiency"]}


def test_a_product_alike_to_a_concept_page_only_in_context_stays_apart(replay, monkeypatch):
    """"Color Oracle" / the page "Color blindness simulation": 0.4523 by
    name, 0.7658 with context. Under the 0.6 name floor across kinds, so
    it is never asked and never merged."""
    from routers import resolution  # noqa: PLC0415

    module, _calls = replay
    item = _item("color-oracle-vs-colorblindness-simulation-page")
    monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Measured(item["a"]["name"], item["a"]["context"], {
        "Color blindness simulation": (0.4523, 0.7658)}))
    assert module.judge(item, "http://x", None) == {"got": "different", "by": "never asked", "answer": None}
    assert module.judge(item, "http://x", "deepseek-flash")["got"] == "different"


def test_scores_and_the_input_order_check(replay):
    module, _calls = replay
    results = [{"expected": "same", "got": "same"}, {"expected": "different", "got": "same"},
               {"expected": "same", "got": "different"}, {"expected": "different", "got": "different"}]
    assert module.scores(results) == {"tp": 1, "fp": 1, "fn": 1, "pairs": 4, "precision": 0.5, "recall": 0.5}
    assert module.shuffle_check([_item("paul-graham-vs-paul-allen"), _item("gpt-4-spellings"),
                                 _item("apca-page-vs-apca-contrast-algorithm"), _item("eth-is-ethereum")],
                                "http://x", 3, seed=1) == []


def test_main_saves_a_run_and_compares_against_it(replay, tmp_path, capsys):
    module, _calls = replay
    module.PAIRS = tmp_path / "pairs.json"
    module.PAIRS.write_text(json.dumps({"items": [_item("ml-is-machine-learning"), _item("chrome-vs-chroma")]}),
                            encoding="utf-8")
    before = tmp_path / "before.json"
    assert module.main(["--no-llm", "--shuffles", "1", "--save", str(before)]) == 0
    saved = json.loads(before.read_text(encoding="utf-8"))
    assert [r["got"] for r in saved["results"]] == ["different", "different"]
    assert module.main(["--model", "deepseek-flash", "--shuffles", "0", "--compare", str(before)]) == 0
    out = capsys.readouterr().out
    assert "ml-is-machine-learning: different → same" in out
    assert "precision" in out and "recall" in out
