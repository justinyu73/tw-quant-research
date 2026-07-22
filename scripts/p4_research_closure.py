#!/usr/bin/env python3
"""Deterministic audit for the TQE research-only runtime boundary."""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_audit(root: Path = ROOT) -> dict[str, object]:
    manifest = json.loads((root / "workflow/engine-manifest.json").read_text(encoding="utf-8"))
    browser_code = "\n".join(
        (root / relative).read_text(encoding="utf-8")
        for relative in ("ui/dashboard/dashboard-core.js", "ui/dashboard/app.js")
    ).lower()
    sidecar_code = (root / "src/tw_quant_engine/desktop_sidecar.py").read_text(encoding="utf-8")
    tauri_code = (root / "frontend/src-tauri/src/lib.rs").read_text(encoding="utf-8")
    checks = {
        "manifest_research_only": manifest.get("mode") == "research-only" and manifest.get("provider_calls") is False,
        "manifest_no_live_trading": manifest.get("live_trading") is False,
        "browser_loopback_only": "127.0.0.1" in browser_code and "websocket" not in browser_code and "xmlhttprequest" not in browser_code,
        "browser_no_order_route": "/orders" not in browser_code,
        "sidecar_get_only": "def do_GET" in sidecar_code and all(f"def do_{method}" in sidecar_code for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD")),
        "tauri_write_scope_is_watchlist_and_alerts": (
            "watchlist::load_watchlist" in tauri_code
            and "watchlist::save_watchlist" in tauri_code
            and "alerts::load_alerts" in tauri_code
            and "alerts::save_alerts" in tauri_code
            and "order" not in tauri_code.lower()
        ),
        "strategy_not_admitted": "not_admitted" in browser_code,
    }
    return {
        "schema": "tw-quant-engine-p4-research-closure/v1",
        "status": "pass" if all(checks.values()) else "fail",
        "checks": checks,
        "provider_calls": False,
        "live_trading": False,
        "write_routes": False,
        "human_gate": "required_before_runtime_or_execution_promotion",
    }


def main() -> int:
    result = run_audit()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
