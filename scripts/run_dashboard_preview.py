"""Run local dashboard preview checks without writing repo evidence."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _command(argv: list[str]) -> dict[str, object]:
    result = subprocess.run(argv, cwd=ROOT, text=True, capture_output=True, check=False)
    return {"argv": argv, "exit_code": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}


def main() -> int:
    from build_dashboard_preview import build_preview

    with tempfile.TemporaryDirectory(prefix="tw-quant-dashboard-") as directory:
        output = Path(directory) / "dashboard-preview"
        summary = build_preview(output)
        html = (output / "index.html").read_text(encoding="utf-8")
        browser_code = "\n".join((output / name).read_text(encoding="utf-8") for name in ("dashboard-core.js", "app.js"))
        static_checks = {
            "expected_assets": summary["files"] == ["app.js", "dashboard-core.js", "index.html", "lightweight-charts.js", "styles.css"],
            "kline_bundle": (output / "lightweight-charts.js").stat().st_size > 100000,
            "read_only_snapshot": summary["read_only"] is True,
            "schema_embedded": "tw-quant-engine-read-only-product-view/v1" in html,
            "runtime_sidecar_is_loopback": "fetch(" in browser_code.lower() and "http://127.0.0.1" in browser_code.lower(),
            "no_external_browser_network": all(token not in browser_code.lower() for token in ("xmlhttprequest", "websocket", "https://")),
            "no_sidecar_write_route": "/orders" not in browser_code.lower() and not re.search(r"fetch\([^)]*method\s*:\s*[\"'](?:post|put|patch|delete)", browser_code.lower()),
            "dialog_contract": all(token in browser_code for token in ("role=\"dialog\"", "data-action=\"close-dialog\"", "Escape")),
        }
        node = shutil.which("node")
        commands: dict[str, object] = {}
        if node:
            commands["core_syntax"] = _command([node, "--check", "ui/dashboard/dashboard-core.js"])
            commands["app_syntax"] = _command([node, "--check", "ui/dashboard/app.js"])
            commands["interaction_reducer"] = _command([node, "tests/dashboard-core.test.cjs"])
        else:
            commands["node"] = {"status": "unavailable"}
        command_pass = all(value.get("exit_code") == 0 for value in commands.values() if isinstance(value, dict) and "exit_code" in value)
        status = "pass" if all(static_checks.values()) and command_pass and bool(node) else "fail"
        print(json.dumps({"status": status, "summary": summary, "static_checks": static_checks, "commands": commands}, ensure_ascii=False, sort_keys=True))
        return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
