"""Re-run only the sources that timed out in the original Phase 7 corpus run.

Reads results.json, finds entries where any provider's HTTP status is -1
(socket-level error / urlopen timeout), and re-runs each with a 600s
timeout instead of the runner's 240s. Merges the new outcomes back into
results.json under the same keys.

600s covers Open Standards (95K chars) on DeepSeek where reasoning can
push past the runner's default 240s ceiling.

Run with the docker compose stack up (nlp-service on 127.0.0.1:8000):

    python validation/2026-05-05-multi-provider-corpus/rerun_timeouts.py
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


CORPUS = Path(__file__).resolve().parents[2] / "nlp-service" / "test_corpus"
NLP_BASE = "http://localhost:8000"
RESULTS = Path(__file__).resolve().parent / "results.json"
TIMEOUT_S = 600


def _post_extract(source_id: str, markdown: str, model: str, timeout: int) -> tuple[int, dict | None]:
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
        with urllib.request.urlopen(req, timeout=timeout) as r:
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
            "entity_count":        len(resp.get("entities", []) or []),
            "concept_count":       len(resp.get("concepts", []) or []),
            "claim_count":         len(resp.get("claims", []) or []),
            "relationship_count":  len(resp.get("relationships", []) or []),
            "contradiction_count": len(resp.get("contradictions", []) or []),
            "summary_chars":       len(resp.get("summary", "") or ""),
        }
    detail = resp.get("detail", "")
    return {"ok": False, "detail": detail[:500] if isinstance(detail, str) else str(resp)[:500]}


def main() -> int:
    if not RESULTS.exists():
        print(f"[rerun] {RESULTS} missing — run runner.py first", file=sys.stderr)
        return 1
    data = json.loads(RESULTS.read_text(encoding="utf-8"))

    # DeepSeek-only rerun: Gemini's monthly quota is exhausted (429 on the
    # last source in the original run), so retrying Gemini won't help and
    # would just consume the runner's wall-clock budget.
    todo: list[tuple[str, str]] = []  # (source_name, model)
    for src in data["sources"]:
        for model, summary in src["results"].items():
            if summary.get("http_status") == -1 and model.startswith("deepseek-"):
                todo.append((src["name"], model))

    if not todo:
        print("[rerun] no timed-out entries found")
        return 0

    print(f"[rerun] {len(todo)} retries at timeout={TIMEOUT_S}s:")
    for name, model in todo:
        print(f"  - {name} :: {model}")

    src_by_name = {src["name"]: src for src in data["sources"]}

    for name, model in todo:
        src_path = CORPUS / name
        markdown = src_path.read_text(encoding="utf-8")
        print(f"[rerun] {name} :: {model} ({len(markdown)} chars)", flush=True)
        t0 = time.time()
        status, body = _post_extract(src_path.stem, markdown, model, TIMEOUT_S)
        elapsed = time.time() - t0
        summary = _summarize(body)
        summary["http_status"] = status
        summary["elapsed_s"] = round(elapsed, 2)
        summary["retry_with_timeout_s"] = TIMEOUT_S
        src_by_name[name]["results"][model] = summary
        outcome = "ok" if summary.get("ok") else "FAIL"
        counts = (
            f"e={summary.get('entity_count')} c={summary.get('concept_count')} "
            f"cl={summary.get('claim_count')} r={summary.get('relationship_count')}"
            if summary.get("ok") else summary.get("detail", str(body))[:120]
        )
        print(f"  HTTP {status} {outcome} ({elapsed:.1f}s) {counts}", flush=True)

    data["rerun_at"] = datetime.now(timezone.utc).isoformat()
    data["rerun_timeout_s"] = TIMEOUT_S
    RESULTS.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[rerun] updated {RESULTS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
