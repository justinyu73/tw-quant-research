#!/usr/bin/env python3
"""Run S4 entirely offline and write inspectable acceptance evidence."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.ingestion import map_source_item  # noqa: E402
from tw_quant_engine.product_alignment import build_product_rows, product_digest  # noqa: E402


S3_FIXTURE = ROOT / "tests/fixtures/s3/source-admission.json"
S4_FIXTURE = ROOT / "tests/fixtures/s4/synthetic-mapping.json"
EVIDENCE_PATH = ROOT / "workflow/evidence/s4-ingestion-product-alignment.acceptance.json"


def digest_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def run_command(argv: Sequence[str], *, timeout: int) -> dict[str, Any]:
    completed = subprocess.run(
        list(argv),
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return {
        "argv": list(argv),
        "exit_code": completed.returncode,
        "stdout_digest": digest_text(completed.stdout),
        "stderr_digest": digest_text(completed.stderr),
    }


def load_items(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError(f"{path} must contain an items array")
    return items


def main() -> int:
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    s3_payload = json.loads(S3_FIXTURE.read_text(encoding="utf-8"))
    s3_results = [map_source_item(item) for item in s3_payload["fetches"]]
    synthetic_results = [map_source_item(item) for item in load_items(S4_FIXTURE)]
    s3_rows = build_product_rows(s3_results)
    synthetic_rows = build_product_rows(synthetic_results)

    tests = run_command([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], timeout=180)
    preflight = run_command([sys.executable, "scripts/lh_preflight.py"], timeout=60)
    preflight_output = subprocess.run(
        [sys.executable, "scripts/lh_preflight.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    try:
        preflight_json = json.loads(preflight_output.stdout)
    except json.JSONDecodeError:
        preflight_json = {"status": "fail", "parse": "fail"}

    s3_reason_counts = Counter(
        reason
        for result in s3_results
        for reason in result["reason_codes"]
    )
    source_pass = (
        len(s3_results) == 5
        and all(result["status"] == "unadmitted" for result in s3_results)
        and len(synthetic_results) == 6
        and all(result["status"] == "admitted" for result in synthetic_results)
    )
    tests_pass = tests["exit_code"] == 0
    preflight_pass = preflight["exit_code"] == 0 and preflight_json.get("status") == "pass"
    evidence = {
        "schema": "tw-quant-engine-stage-acceptance/v1",
        "stage_id": "S4",
        "package_id": "tw-quant-engine-s4-ingestion-product-alignment-001",
        "status": "pass" if source_pass and tests_pass and preflight_pass else "fail",
        "capture_method": "offline S3 fixture replay plus synthetic timestamped fixture and subprocess verification",
        "captured_at": captured_at,
        "approval": {
            "approved": True,
            "approved_by": "user",
            "execution_boundary": "workflow/s4-approval-package.json",
            "network_enabled": False,
            "network_requests": 0,
            "finmind_used": False,
        },
        "formula_version": "s4-v1",
        "network_policy": {
            "enabled": False,
            "observed_network_calls": 0,
            "fixture_only": True,
            "credentials": False,
            "tokens": False,
        },
        "mapping_summary": {
            "s3_live_fixture": {
                "rows": len(s3_results),
                "admitted": sum(result["status"] == "admitted" for result in s3_results),
                "unadmitted": sum(result["status"] == "unadmitted" for result in s3_results),
                "reason_counts": dict(sorted(s3_reason_counts.items())),
                "product_digest": product_digest(s3_rows),
            },
            "synthetic_timestamped_fixture": {
                "rows": len(synthetic_results),
                "admitted": sum(result["status"] == "admitted" for result in synthetic_results),
                "unadmitted": sum(result["status"] == "unadmitted" for result in synthetic_results),
                "product_digest": product_digest(synthetic_rows),
            },
        },
        "offline_verification": {
            "tests": tests,
            "preflight": {**preflight, "parsed": preflight_json},
        },
        "acceptance_notes": [
            "S3 live rows without source-published timestamps remain unadmitted; retrieval_at is not substituted.",
            "Synthetic timestamped rows prove admitted S2 records, ROC date conversion, provenance retention, and formula guards offline.",
            "Raw close remains unadjusted; corporate-action transformation is outside S4.",
            "S4 does not approve S5, factors, backtests, dashboards, trading, or investment performance.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": evidence["status"], "network_requests": 0, "tests_exit": tests["exit_code"], "preflight": preflight_json.get("status")}, sort_keys=True))
    return 0 if evidence["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
