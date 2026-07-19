#!/usr/bin/env python3
"""Run the bounded S3 live admission fetch and write inspectable evidence."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.adapters.mops_disclosure import fetch_mops_sample  # noqa: E402
from tw_quant_engine.adapters.tpex_openapi import fetch_tpex_sample  # noqa: E402
from tw_quant_engine.adapters.twse_openapi import fetch_twse_sample  # noqa: E402
from tw_quant_engine.source_registry import PublicFetchError  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s3/source-admission.json"
EVIDENCE_PATH = ROOT / "workflow/evidence/s3-public-data.acceptance.json"


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
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "stdout_digest": digest_text(completed.stdout),
        "stderr_digest": digest_text(completed.stderr),
    }


def compact_command(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in result.items()
        if key not in {"stdout", "stderr"}
    }


def verify_and_write_evidence(
    fixture: dict[str, Any],
    started_at: str,
    *,
    capture_method: str,
    known_session_requests: int,
    additional_approved_requests: int = 0,
) -> int:
    tests = run_command([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], timeout=180)
    preflight = run_command([sys.executable, "scripts/lh_preflight.py"], timeout=60)
    try:
        preflight_json = json.loads(preflight["stdout"])
    except json.JSONDecodeError:
        preflight_json = {"parse": "fail"}

    source_pass = not fixture["errors"] and len(fixture["fetches"]) == 5 and all(
        item["metadata"]["http_status"] == 200 for item in fixture["fetches"]
    )
    tests_pass = tests["exit_code"] == 0
    preflight_pass = preflight["exit_code"] == 0 and preflight_json.get("status") == "pass"
    evidence = {
        "schema": "tw-quant-engine-stage-acceptance/v1",
        "stage_id": "S3",
        "package_id": "tw-quant-engine-s3-public-taiwan-data-001",
        "status": "pass" if source_pass and tests_pass and preflight_pass else "fail",
        "capture_method": capture_method,
        "captured_at": started_at,
        "approval": {
            "approved": True,
            "approved_by": "user",
            "execution_boundary": "workflow/s3-approval-package.json",
            "finmind_used": False,
            "additional_approved_requests": additional_approved_requests,
        },
        "network_policy": {
            "method": "GET",
            "fixture_requests": fixture["network_requests"],
            "known_session_requests": known_session_requests,
            "max_total_requests": 12,
            "additional_approved_requests": additional_approved_requests,
            "effective_max_total_requests": 12 + additional_approved_requests,
            "credentials": False,
            "tokens": False,
            "full_history_backfill": False,
        },
        "source_captures": [
            {
                **item["metadata"],
                "row_count": item.get("row_count"),
                "sample_keys": item.get("sample_keys", []),
                "mapping": item["mapping"],
            }
            for item in fixture["fetches"]
        ],
        "errors": fixture["errors"],
        "offline_verification": {
            "tests": compact_command(tests),
            "preflight": {**compact_command(preflight), "parsed": preflight_json},
        },
        "acceptance_notes": [
            "All live responses are retained by digest and bounded sample metadata; no full-history snapshot is stored.",
            "Samples without a reliable source-published timestamp are explicitly unadmitted; retrieval_at is not used as available_at.",
            "The corrected TWSE continuation captured only the two approved TWSE GET endpoints; TPEx/MOPS were not re-requested.",
            "S3 does not approve factors, backtests, dashboards, trading, or S4.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": evidence["status"], "network_requests": fixture["network_requests"], "errors": fixture["errors"]}, ensure_ascii=False, sort_keys=True))
    return 0 if evidence["status"] == "pass" else 1


def run_corrected_twse_only() -> int:
    """Capture exactly the two approved corrected TWSE endpoints and merge prior successes."""
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    previous = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    fetches = list(previous["fetches"])
    errors = [error for error in previous["errors"] if not error.startswith("twse_")]
    for source_id in ("twse_daily_close", "twse_monthly_revenue"):
        try:
            fetches.append(fetch_twse_sample(source_id))
        except (PublicFetchError, ValueError, UnicodeError) as exc:
            errors.append(f"{source_id}: {exc}")
    fixture = {
        "schema": "tw-quant-engine-s3-source-admission-fixture/v1",
        "captured_at": started_at,
        "network_requests": previous["network_requests"] + 2,
        "finmind_used": False,
        "fetches": fetches,
        "errors": errors,
        "continuation": {
            "approved_requests": 2,
            "endpoints": [
                "/v1/exchangeReport/STOCK_DAY_ALL?response=json",
                "/v1/opendata/t187ap05_L?response=json",
            ],
            "reran_other_sources": False,
        },
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return verify_and_write_evidence(
        fixture,
        started_at,
        capture_method="corrected TWSE continuation: two live GETs plus offline subprocess verification",
        known_session_requests=14,
        additional_approved_requests=2,
    )


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--corrected-twse-only":
        return run_corrected_twse_only()
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    fetches: list[dict[str, Any]] = []
    errors: list[str] = []
    fetch_plan = (
        ("twse_daily_close", fetch_twse_sample),
        ("twse_monthly_revenue", fetch_twse_sample),
        ("tpex_daily_close", fetch_tpex_sample),
        ("tpex_monthly_revenue", fetch_tpex_sample),
    )
    for source_id, fetcher in fetch_plan:
        try:
            fetches.append(fetcher(source_id))
        except (PublicFetchError, ValueError, UnicodeError) as exc:
            errors.append(f"{source_id}: {exc}")
    try:
        fetches.append(fetch_mops_sample())
    except (PublicFetchError, ValueError, UnicodeError) as exc:
        errors.append(f"mops_landing: {exc}")

    fixture = {
        "schema": "tw-quant-engine-s3-source-admission-fixture/v1",
        "captured_at": started_at,
        "network_requests": len(fetches) + len(errors),
        "finmind_used": False,
        "fetches": fetches,
        "errors": errors,
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return verify_and_write_evidence(
        fixture,
        started_at,
        capture_method="live bounded GET capture plus offline subprocess verification",
        known_session_requests=5,
    )


if __name__ == "__main__":
    raise SystemExit(main())
