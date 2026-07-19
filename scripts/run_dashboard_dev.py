"""Run a local DEV smoke for the read-only dashboard preview.

The smoke intentionally uses only loopback HTTP. It proves that the generated
bundle can be served and that the S8 read model, UI shell, and interaction
contracts line up without calling an external provider or opening a write
route.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_dashboard_preview import build_preview, build_view  # noqa: E402


ASSETS = ("index.html", "dashboard-core.js", "app.js", "styles.css", "lightweight-charts.js")
REQUIRED_APP_MARKUP = (
    'class="sidebar"',
    'class="topbar"',
    'class="page-wrapper"',
    'class="card',
    'class="table',
    'role="dialog"',
    'data-action="close-dialog"',
    'data-testid="kline-chart"',
    'data-action="kline-period"',
)
REQUIRED_CSS_SELECTORS = (
    ".sidebar",
    ".topbar",
    ".page-wrapper",
    ".card",
    ".table",
    ".modal",
    "@media",
)


class _QuietHandler(SimpleHTTPRequestHandler):
    """Serve the temporary preview without noisy test logs."""

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


class _AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "script" and attributes.get("src"):
            self.references.append(str(attributes["src"]))
        if tag == "link" and attributes.get("href"):
            self.references.append(str(attributes["href"]))


@contextmanager
def _serve(directory: Path):
    handler = partial(_QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _get(base: str, path: str) -> dict[str, object]:
    request = Request(f"{base}/{path}", headers={"Connection": "close"})
    try:
        with urlopen(request, timeout=5) as response:  # nosec B310 - loopback-only base
            body = response.read()
            return {
                "status": response.status,
                "content_type": response.headers.get_content_type(),
                "bytes": len(body),
            }
    except HTTPError as error:
        return {"status": error.code, "content_type": "", "bytes": 0}


def _node_checks() -> dict[str, object]:
    node = shutil.which("node")
    if not node:
        return {"status": "unavailable"}
    commands = {
        "core_syntax": [node, "--check", "ui/dashboard/dashboard-core.js"],
        "app_syntax": [node, "--check", "ui/dashboard/app.js"],
        "interaction_reducer": [node, "tests/dashboard-core.test.cjs"],
    }
    results: dict[str, object] = {}
    for name, argv in commands.items():
        result = subprocess.run(argv, cwd=ROOT, text=True, capture_output=True, check=False)
        results[name] = {
            "exit_code": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    results["status"] = "pass" if all(
        isinstance(value, dict) and value.get("exit_code") == 0
        for key, value in results.items()
        if key != "status"
    ) else "fail"
    return results


def collect_report(*, serve_loopback: bool = True) -> dict[str, object]:
    """Build and validate the complete local DEV surface.

    ``serve_loopback=False`` keeps the repository unit test free of socket
    permissions while the command-line DEV smoke still runs the full local
    HTTP check.
    """
    with tempfile.TemporaryDirectory(prefix="tw-quant-dashboard-dev-") as directory:
        output = Path(directory) / "dashboard-preview"
        summary = build_preview(output)
        view = build_view()
        index = (output / "index.html").read_text(encoding="utf-8")
        app = (output / "app.js").read_text(encoding="utf-8")
        core = (output / "dashboard-core.js").read_text(encoding="utf-8")
        styles = (output / "styles.css").read_text(encoding="utf-8")

        parser = _AssetParser()
        parser.feed(index)
        local_asset_refs = all(reference.startswith("./") for reference in parser.references)
        asset_reference_text = "\n".join(parser.references).lower()
        browser_code = f"{core}\n{app}".lower()
        data_checks = {
            "schema": summary["schema"] == "tw-quant-engine-read-only-product-view/v1",
            "read_only": summary["read_only"] is True and view["read_only"] is True,
            "product_rows": summary["product_count"] == len(view["products"]) == 3,
            "feature_rows": summary["feature_count"] == len(view["features"]) == 1,
            "digest_present": isinstance(summary["view_digest"], str) and summary["view_digest"].startswith("sha256:"),
        }
        route_checks = {}
        from tw_quant_engine.product_view import read_only_request

        for route in ("/", "/health", "/products", "/features", "/backtest", "/evidence"):
            route_checks[route] = read_only_request(view, "GET", route)["status"] == 200
        route_checks["reject_write"] = read_only_request(view, "POST", "/products")["status"] == 405
        route_checks["reject_unknown"] = read_only_request(view, "GET", "/unknown")["status"] == 404

        ui_checks = {
            "local_asset_refs": local_asset_refs,
            "no_external_asset_url": all(token not in asset_reference_text for token in ("http://", "https://")),
            "required_markup": all(token in app for token in REQUIRED_APP_MARKUP),
            "required_css": all(token in styles for token in REQUIRED_CSS_SELECTORS),
            "browser_runtime_sidecar_loopback": "fetch(" in browser_code and "http://127.0.0.1" in browser_code,
            "browser_no_external_network": all(token not in browser_code for token in ("xmlhttprequest", "websocket", "https://")),
            "browser_no_sidecar_write_route": "/orders" not in browser_code and not re.search(r"fetch\([^)]*method\s*:\s*[\"'](?:post|put|patch|delete)", browser_code),
        }

        if serve_loopback:
            with _serve(output) as base:
                served = {asset: _get(base, asset) for asset in ASSETS}
                connection_checks = {
                    asset: response["status"] == 200 and int(response["bytes"]) > 0
                    for asset, response in served.items()
                }
                connection_checks["missing_route_404"] = _get(base, "missing.js")["status"] == 404
        else:
            served = {asset: {"status": "not_run", "content_type": "", "bytes": 0} for asset in ASSETS}
            connection_checks = {"loopback_smoke_not_run": True}

        node_checks = _node_checks()
        checks = {
            **{f"data.{key}": value for key, value in data_checks.items()},
            **{f"read_model.{key}": value for key, value in route_checks.items()},
            **{f"ui.{key}": value for key, value in ui_checks.items()},
            **{f"loopback.{key}": value for key, value in connection_checks.items()},
            "node.status": node_checks.get("status") == "pass",
        }
        return {
            "status": "pass" if all(checks.values()) else "fail",
            "scope": {
                "data_source": "S8/S7 fixtures + K6a/K6b loopback sidecar for Market detail",
                "connection": "127.0.0.1 loopback only",
                "provider_calls": False,
                "write_routes": False,
                "visual_browser": "separate Playwright pixel gate",
            },
            "summary": summary,
            "served_assets": served,
            "checks": checks,
            "node": node_checks,
        }


if __name__ == "__main__":
    report = collect_report()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    raise SystemExit(0 if report["status"] == "pass" else 1)
