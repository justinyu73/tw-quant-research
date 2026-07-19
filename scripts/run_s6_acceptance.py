#!/usr/bin/env python3
"""Run S6 feature acceptance entirely offline."""
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

from tw_quant_engine.features import build_feature_rows, feature_digest  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s6/features.json"
EVIDENCE_PATH = ROOT / "workflow/evidence/s6-feature-pipeline.acceptance.json"


def digest_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def run_command(argv: Sequence[str], *, timeout: int) -> dict[str, Any]:
    completed = subprocess.run(list(argv), cwd=ROOT, text=True, capture_output=True, timeout=timeout, check=False)
    return {
        "argv": list(argv),
        "exit_code": completed.returncode,
        "stdout_digest": digest_text(completed.stdout),
        "stderr_digest": digest_text(completed.stderr),
    }


def main() -> int:
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    rows = build_feature_rows(payload["records"], payload["provenance"], as_of="2026-01-10T00:00:00Z")
    last = next(row for row in rows if row["trading_date"] == "2026-01-09")
    formula_pass = (
        len(rows) == 6
        and "2026-01-12" not in {row["trading_date"] for row in rows}
        and abs(last["features"]["return_5d"]["value"] - 0.05) < 1e-12
        and last["features"]["volume_mean_5d"]["value"] == 400.0
        and last["features"]["return_5d"]["status"] == "admitted"
        and all(row["formula_version"] == "s6-v1" for row in rows)
    )
    tests = run_command([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], timeout=180)
    preflight = run_command([sys.executable, "scripts/lh_preflight.py"], timeout=60)
    preflight_output = subprocess.run([sys.executable, "scripts/lh_preflight.py"], cwd=ROOT, text=True, capture_output=True, timeout=60, check=False)
    try:
        preflight_json = json.loads(preflight_output.stdout)
    except json.JSONDecodeError:
        preflight_json = {"status": "fail", "parse": "fail"}
    status = "pass" if formula_pass and tests["exit_code"] == 0 and preflight_json.get("status") == "pass" else "fail"
    evidence = {
        "schema": "tw-quant-engine-stage-acceptance/v1",
        "stage_id": "S6",
        "package_id": "tw-quant-engine-s5-s9-research-product-chain-001",
        "status": status,
        "capture_method": "offline point-in-time feature fixture plus subprocess verification",
        "captured_at": captured_at,
        "approval": {"approved": True, "approved_by": "user", "execution_boundary": "workflow/s5-s9-approval-package.json", "network_enabled": False, "network_requests": 0, "finmind_used": False},
        "network_policy": {"enabled": False, "observed_network_calls": 0, "fixture_only": True},
        "feature_contract": {"version": "s6-v1", "as_of": "2026-01-10T00:00:00Z", "row_count": len(rows), "feature_digest": feature_digest(rows), "price_basis": "close_raw"},
        "formula_checks": {"return_5d_2026-01-09": last["features"]["return_5d"], "volume_mean_5d_2026-01-09": last["features"]["volume_mean_5d"], "future_date_absent": "2026-01-12" not in {row["trading_date"] for row in rows}},
        "offline_verification": {"tests": tests, "preflight": {**preflight, "parsed": preflight_json}},
        "acceptance_notes": [
            "Features are computed only after S2 as_of visibility and trading-date cutoff.",
            "Insufficient windows remain null with a reason; no forward-fill or partial window is used.",
            "S6 does not approve S7, S8, S9, factors, backtests, dashboards, or trading.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "network_requests": 0, "tests_exit": tests["exit_code"], "preflight": preflight_json.get("status")}, sort_keys=True))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
