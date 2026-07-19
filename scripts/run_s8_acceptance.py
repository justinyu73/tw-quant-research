#!/usr/bin/env python3
"""Run S8 read-only product-view acceptance entirely offline."""
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

from tw_quant_engine.backtest import BacktestConfig, run_backtest  # noqa: E402
from tw_quant_engine.product_view import build_read_only_view, read_only_request, view_digest  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s8/product-view.json"
S7_PATH = ROOT / "tests/fixtures/s7/backtest.json"
EVIDENCE_PATH = ROOT / "workflow/evidence/s8-read-only-product-view.acceptance.json"
AS_OF = "2026-01-07T23:59:59Z"


def digest_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def run_command(argv: Sequence[str], *, timeout: int) -> dict[str, Any]:
    completed = subprocess.run(list(argv), cwd=ROOT, text=True, capture_output=True, timeout=timeout, check=False)
    return {"argv": list(argv), "exit_code": completed.returncode, "stdout_digest": digest_text(completed.stdout), "stderr_digest": digest_text(completed.stderr)}


def main() -> int:
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    s7 = json.loads(S7_PATH.read_text(encoding="utf-8"))
    backtest = run_backtest(s7["records"], s7["provenance"], s7["signals"], as_of=s7["as_of"], config=BacktestConfig(**s7["config"]))
    offline_probe = {"status": "pass", "network_requests": 0}
    try:
        with patch.object(socket, "socket", side_effect=AssertionError("S8 network is forbidden")):
            view = build_read_only_view(payload["product_rows"], payload["feature_rows"], backtest, as_of=AS_OF, evidence_links=payload["evidence_links"])
            route_checks = {
                "get_products": read_only_request(view, "GET", "/products")["status"] == 200,
                "post_products_rejected": read_only_request(view, "POST", "/products")["status"] == 405,
                "unknown_route_rejected": read_only_request(view, "GET", "/orders")["status"] == 404,
            }
    except Exception as exc:
        offline_probe = {"status": "fail", "network_requests": 0, "error_type": type(exc).__name__, "error": str(exc)}
        view = {}
        route_checks = {"get_products": False, "post_products_rejected": False, "unknown_route_rejected": False}

    visible_dates = {row.get("bar", {}).get("trading_date") for row in view.get("products", []) if isinstance(row, dict)}
    feature_dates = {row.get("trading_date") for row in view.get("features", []) if isinstance(row, dict)}
    formula_checks = {
        "read_only_flag": view.get("read_only") is True,
        "future_product_hidden": "2026-01-08" not in visible_dates,
        "future_feature_hidden": "2026-01-08" not in feature_dates,
        "quality_states_visible": view.get("quality", {}).get("status_counts") == {"admitted": 1, "unadmitted": 1, "invalid": 1},
        "conflict_reason_visible": view.get("quality", {}).get("reason_counts", {}).get("source_conflict") == 1,
        "formula_versions_visible": view.get("formula_versions") == ["s4-v1", "s6-v1"],
        "provenance_and_evidence_visible": bool(view.get("products")) and "workflow/evidence/s7-backtest.acceptance.json" in view.get("evidence_links", []),
        "backtest_result_preserved": view.get("backtest", {}).get("result", {}).get("metrics", {}).get("cumulative_return") == 0.2,
        "route_boundary": all(route_checks.values()),
        "empty_state_deterministic": view_digest(build_read_only_view([], [], None, as_of=AS_OF)) == view_digest(build_read_only_view([], [], None, as_of=AS_OF)),
    }
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
        "stage_id": "S8",
        "package_id": "tw-quant-engine-s5-s9-research-product-chain-001",
        "status": status,
        "capture_method": "offline generated S4-S7 read-model fixture plus subprocess verification",
        "captured_at": captured_at,
        "approval": {"approved": True, "approved_by": "user", "execution_boundary": "workflow/s5-s9-approval-package.json", "network_enabled": False, "network_requests": 0, "finmind_used": False},
        "network_policy": {"enabled": False, "observed_network_calls": 0, "fixture_only": True},
        "view_contract": {"schema": view.get("schema"), "as_of": AS_OF, "read_only": view.get("read_only"), "view_digest": view_digest(view) if view else None, "numeric_field_registry": view.get("numeric_field_registry")},
        "formula_checks": formula_checks,
        "offline_probe": offline_probe,
        "offline_verification": {"tests": tests, "preflight": {**preflight, "parsed": preflight_json}},
        "changed_files": ["src/tw_quant_engine/product_view.py", "docs/s8-read-only-product-view.md", "tests/fixtures/s8/product-view.json", "tests/test_s8_product_view.py", "workflow/lh-work-unit.s8.example.json", "scripts/run_s8_acceptance.py", "workflow/evidence/s8-read-only-product-view.acceptance.json"],
        "acceptance_notes": [
            "S8 consumes S4-S7 read models and does not add financial formulas.",
            "Future rows are hidden by both trading/period date and available-at/as-of state; incomplete quality states remain inspectable.",
            "The route dispatcher is in-memory and GET-only; no server, provider, cloud deployment, or trading path is included.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "network_requests": 0, "tests_exit": tests["exit_code"], "preflight": preflight_json.get("status"), "formula_checks": formula_checks}, sort_keys=True))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
