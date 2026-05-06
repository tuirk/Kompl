"""Phase 7 corpus revalidation runner.

Walks nlp-service/test_corpus/, posts each source to /pipeline/extract-llm
with both compile_model=gemini-2.5-flash and compile_model=deepseek-v4-pro,
captures entity/concept/claim/relationship counts + finish_reason + ok flag,
and writes the result to results.json.

Run with the docker compose stack up (nlp-service on 127.0.0.1:8000):

    python validation/2026-05-05-multi-provider-corpus/runner.py

Cost: 7 sources x 2 providers = 14 LLM calls. Expected total spend ~$0.50
on Gemini Flash + DeepSeek (discount window). Daily LLM cap is $5.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


CORPUS = Path(__file__).resolve().parents[2] / "nlp-service" / "test_corpus"
NLP_BASE = "http://localhost:8000"
PROVIDERS = ["gemini-2.5-flash", "deepseek-v4-pro"]


def _git_head() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=Path(__file__).resolve().parent
        ).decode().strip()
    except Exception:
        return "unknown"


def _post_extract(source_id: str, markdown: str, model: str) -> tuple[int, dict | None]:
    payload = json.dumps(
        {
            "source_id": source_id,
            "markdown": markdown,
            "ner_output": {"entities": []},
            "keyphrase_output": None,
            "tfidf_output": None,
            "compile_model": model,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{NLP_BASE}/pipeline/extract-llm",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body[:1000]}
    except Exception as e:
        return -1, {"error": str(e)}


def _summarize(resp: dict) -> dict:
    if not isinstance(resp, dict):
        return {"ok": False, "raw": str(resp)[:300]}
    if "entities" in resp and "concepts" in resp:
        return {
            "ok": True,
            "entity_count":       len(resp.get("entities", []) or []),
            "concept_count":      len(resp.get("concepts", []) or []),
            "claim_count":        len(resp.get("claims", []) or []),
            "relationship_count": len(resp.get("relationships", []) or []),
            "contradiction_count": len(resp.get("contradictions", []) or []),
            "summary_chars":      len(resp.get("summary", "") or ""),
        }
    return {"ok": False, "detail": resp.get("detail", "")[:500] if isinstance(resp.get("detail"), str) else str(resp)[:500]}


def main() -> int:
    sources = sorted(p for p in CORPUS.glob("*.md") if p.name != "_manifest.json")
    if not sources:
        print(f"[runner] no sources found in {CORPUS}", file=sys.stderr)
        return 1

    out: dict = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "branch": "feat/multi-provider-llm",
        "head_commit": _git_head(),
        "providers": PROVIDERS,
        "nlp_service_url": NLP_BASE,
        "sources": [],
    }

    for src in sources:
        markdown = src.read_text(encoding="utf-8")
        chars = len(markdown)
        print(f"[runner] {src.name} ({chars} chars)", flush=True)
        entry: dict = {"name": src.name, "markdown_chars": chars, "results": {}}

        for model in PROVIDERS:
            t0 = time.time()
            status, body = _post_extract(src.stem, markdown, model)
            elapsed = time.time() - t0
            summary = _summarize(body)
            summary["http_status"] = status
            summary["elapsed_s"] = round(elapsed, 2)
            entry["results"][model] = summary
            ok_str = "ok" if summary.get("ok") else "FAIL"
            counts = (
                f"e={summary.get('entity_count')} c={summary.get('concept_count')} "
                f"cl={summary.get('claim_count')} r={summary.get('relationship_count')}"
                if summary.get("ok") else summary.get("detail", "")[:120]
            )
            print(f"  [{model}] HTTP {status} {ok_str} ({elapsed:.1f}s) {counts}", flush=True)

        out["sources"].append(entry)

    out_path = Path(__file__).resolve().parent / "results.json"
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[runner] wrote {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
