#!/usr/bin/env python3
"""Run S7 backtest acceptance entirely offline and write inspectable evidence."""
from __future__ import annotations

import hashlib
import json
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.backtest import BacktestConfig, backtest_digest, run_backtest  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s7/backtest.json"
EVIDENCE_PATH = ROOT / "workflow/evidence/s7-backtest.acceptance.json"


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
    config = BacktestConfig(**payload["config"])
    offline_probe = {"status": "pass", "network_requests": 0}
    try:
        with patch.object(socket, "socket", side_effect=AssertionError("S7 network is forbidden")):
            baseline = run_backtest(payload["records"], payload["provenance"], payload["signals"], as_of=payload["as_of"], config=config)
    except Exception as exc:  # evidence must record the actual failed probe
        offline_probe = {"status": "fail", "network_requests": 0, "error_type": type(exc).__name__, "error": str(exc)}
        baseline = {}

    formula_checks = {
        "schema": baseline.get("schema") == "tw-quant-engine-backtest-result/v1",
        "next_bar_open_buy": bool(baseline.get("trades")) and baseline["trades"][0]["signal_date"] == "2026-01-02" and baseline["trades"][0]["execution_date"] == "2026-01-05" and baseline["trades"][0]["execution_price"] == 100.0,
        "next_bar_open_sell": len(baseline.get("trades", [])) > 1 and baseline["trades"][1]["execution_date"] == "2026-01-06" and baseline["trades"][1]["execution_price"] == 120.0,
        "final_equity": baseline.get("equity_curve", [{}])[-1].get("equity") == 1200.0,
        "cumulative_return": baseline.get("metrics", {}).get("cumulative_return") == 0.2,
        "cost_and_slippage_ledger": False,
        "deterministic_digest": False,
    }
    if baseline:
        cost_config = BacktestConfig(initial_cash=1000, transaction_cost_bps=25, slippage_bps=50, calendar_days_per_year=365)
        cost_result = run_backtest(payload["records"], payload["provenance"], payload["signals"], as_of=payload["as_of"], config=cost_config)
        formula_checks["cost_and_slippage_ledger"] = cost_result["equity_curve"][-1]["equity"] < baseline["equity_curve"][-1]["equity"] and cost_result["trades"][0]["transaction_cost_bps"] == 25 and cost_result["trades"][0]["slippage_bps"] == 50 and cost_result["trades"][0]["fee"] > 0
        formula_checks["deterministic_digest"] = backtest_digest(baseline) == backtest_digest(run_backtest(payload["records"], payload["provenance"], payload["signals"], as_of=payload["as_of"], config=config))

    tests = run_command([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], timeout=180)
    preflight = run_command([sys.executable, "scripts/lh_preflight.py"], timeout=60)
    preflight_output = subprocess.run([sys.executable, "scripts/lh_preflight.py"], cwd=ROOT, text=True, capture_output=True, timeout=60, check=False)
    try:
        preflight_json = json.loads(preflight_output.stdout)
    except json.JSONDecodeError:
        preflight_json = {"status": "fail", "parse": "fail"}
    status = "pass" if all(formula_checks.values()) and offline_probe["status"] == "pass" and tests["exit_code"] == 0 and preflight_json.get("status") == "pass" else "fail"
    evidence = {
        "schema": "tw-quant-engine-stage-acceptance/v1",
        "stage_id": "S7",
        "package_id": "tw-quant-engine-s5-s9-research-product-chain-001",
        "status": status,
        "capture_method": "offline synthetic price-bar and admitted-signal fixture plus subprocess verification",
        "captured_at": captured_at,
        "approval": {"approved": True, "approved_by": "user", "execution_boundary": "workflow/s5-s9-approval-package.json", "network_enabled": False, "network_requests": 0, "finmind_used": False},
        "network_policy": {"enabled": False, "observed_network_calls": 0, "fixture_only": True},
        "backtest_contract": {"schema": baseline.get("schema"), "as_of": payload["as_of"], "execution": "signal_date_t -> next visible bar open", "price_basis": "raw_open_and_raw_close", "cost_formula": "gross_notional * transaction_cost_bps / 10000", "slippage_formula": "buy open*(1+bps/10000), sell open*(1-bps/10000)", "result_digest": backtest_digest(baseline) if baseline else None},
        "formula_checks": formula_checks,
        "offline_probe": offline_probe,
        "offline_verification": {"tests": tests, "preflight": {**preflight, "parsed": preflight_json}},
        "changed_files": ["src/tw_quant_engine/backtest.py", "docs/s7-backtest.md", "tests/fixtures/s7/backtest.json", "tests/test_s7_backtest.py", "workflow/lh-work-unit.s7.example.json", "scripts/run_s7_acceptance.py", "workflow/evidence/s7-backtest.acceptance.json"],
        "acceptance_notes": [
            "S7 is research-only and provider-neutral; it does not initialize Qlib or place orders.",
            "A signal is admitted only when its status is admitted and it is visible at the backtest as_of cutoff.",
            "Three consecutive failed acceptance attempts or an unplanned semantic fork stops the S5-S9 sequence.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "network_requests": 0, "tests_exit": tests["exit_code"], "preflight": preflight_json.get("status"), "formula_checks": formula_checks}, sort_keys=True))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
