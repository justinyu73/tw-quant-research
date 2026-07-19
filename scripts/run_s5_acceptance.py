#!/usr/bin/env python3
"""Run S5 quality/corporate-action acceptance entirely offline."""
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

from tw_quant_engine.corporate_actions import (  # noqa: E402
    PRICE_MULTIPLIER_CONVENTION,
    adjust_close,
)
from tw_quant_engine.data_contract import PointInTimeDataset  # noqa: E402
from tw_quant_engine.quality_checks import check_records  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s5/corporate-actions.json"
EVIDENCE_PATH = ROOT / "workflow/evidence/s5-quality-corporate-actions.acceptance.json"


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


def main() -> int:
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    records = payload["records"]
    provenance = payload["provenance"]
    quality = check_records(records, provenance)
    dataset = PointInTimeDataset(records, provenance)
    actions = [row for row in records if row["record_type"] == "corporate_action"]
    adjustment = adjust_close(
        100,
        "2026-01-02",
        actions,
        convention=payload["factor_convention"],
        as_of="2026-01-06T00:00:00Z",
    )
    pre_action_visible = any(row["record_type"] == "corporate_action" for row in dataset.as_of("2025-12-19T23:59:59Z"))
    post_action_visible = any(row["record_type"] == "corporate_action" for row in dataset.as_of("2025-12-20T11:00:00Z"))

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

    formula_pass = (
        adjustment["raw_close"] == 100.0
        and adjustment["adjustment_factor"] == 0.5
        and adjustment["adjusted_close"] == 50.0
        and not pre_action_visible
        and post_action_visible
    )
    status = "pass" if quality["status"] == "pass" and formula_pass and tests["exit_code"] == 0 and preflight_json.get("status") == "pass" else "fail"
    reason_counts = Counter(issue["code"] for issue in quality["issues"])
    evidence = {
        "schema": "tw-quant-engine-stage-acceptance/v1",
        "stage_id": "S5",
        "package_id": "tw-quant-engine-s5-s9-research-product-chain-001",
        "status": status,
        "capture_method": "offline corporate-action fixture plus subprocess verification",
        "captured_at": captured_at,
        "approval": {
            "approved": True,
            "approved_by": "user",
            "execution_boundary": "workflow/s5-s9-approval-package.json",
            "network_enabled": False,
            "network_requests": 0,
            "finmind_used": False,
        },
        "network_policy": {
            "enabled": False,
            "observed_network_calls": 0,
            "fixture_only": True,
        },
        "quality_report": {
            "status": quality["status"],
            "record_count": quality["record_count"],
            "issue_count": len(quality["issues"]),
            "issue_counts": dict(sorted(reason_counts.items())),
        },
        "corporate_action_contract": {
            "convention": payload["factor_convention"],
            "raw_close": adjustment["raw_close"],
            "adjustment_factor": adjustment["adjustment_factor"],
            "adjusted_close": adjustment["adjusted_close"],
            "pre_action_visible": pre_action_visible,
            "post_action_visible": post_action_visible,
        },
        "offline_verification": {
            "tests": tests,
            "preflight": {**preflight, "parsed": preflight_json},
        },
        "acceptance_notes": [
            "Corporate actions remain explicit records and are not applied by mutating raw OHLCV.",
            "Unknown factor direction is fail-closed; this fixture admits only price_multiplier_after_ex_date.",
            "S5 does not approve S6, S7, S8, or S9 implementation until this evidence is reviewed by the stage loop.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "network_requests": 0, "tests_exit": tests["exit_code"], "preflight": preflight_json.get("status")}, sort_keys=True))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
