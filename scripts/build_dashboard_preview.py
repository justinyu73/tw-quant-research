"""Build a local dashboard preview from the S8/S7 fixtures and local assets."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
AS_OF = "2026-01-07T23:59:59Z"
S8_FIXTURE = ROOT / "tests/fixtures/s8/product-view.json"
S7_FIXTURE = ROOT / "tests/fixtures/s7/backtest.json"
TEMPLATE = ROOT / "ui/dashboard/index.template.html"
SOURCE_DIR = ROOT / "ui/dashboard"
CHART_VENDOR = SOURCE_DIR / "vendor/lightweight-charts.js"
DEFAULT_OUTPUT = ROOT / "outputs/dashboard-preview"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sidecar_url() -> str:
    raw = os.getenv("TQE_SIDECAR_URL", "http://127.0.0.1:8766").strip()
    parsed = urlsplit(raw)
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS or not parsed.port:
        raise ValueError("TQE_SIDECAR_URL must be an explicit loopback http URL")
    return f"http://{parsed.netloc}"


def build_view() -> dict[str, Any]:
    """Reproduce the approved S8/K3 snapshots without network or browser logic."""
    import sys

    sys.path.insert(0, str(ROOT / "src"))
    from tw_quant_engine.backtest import BacktestConfig, run_backtest
    from tw_quant_engine.product_view import build_read_only_view, view_digest

    s8 = _load(S8_FIXTURE)
    s7 = _load(S7_FIXTURE)
    result = run_backtest(
        s7["records"],
        s7["provenance"],
        s7["signals"],
        as_of=s7["as_of"],
        config=BacktestConfig(**s7["config"]),
    )
    view = build_read_only_view(
        s8["product_rows"],
        s8["feature_rows"],
        result,
        as_of=AS_OF,
        evidence_links=s8["evidence_links"],
    )
    view["view_digest"] = view_digest(view)
    # K-line data is deliberately not embedded here.  The Market detail page
    # fetches the K6a/K6b read model from the loopback sidecar at runtime;
    # Overview/Products/Backtest/Evidence remain the approved S8/S7 fixture.
    view["kline"] = {
        "schema": "tw-quant-engine-kline-read-model/v1",
        "read_only": True,
        "runtime_fetch": True,
        "default_instrument_id": "TWSE:2330",
        "default_period": "1D",
        "instruments": [],
        "models": [],
    }
    view["kline_digest"] = view_digest(view["kline"])
    return view


def build_preview(output_dir: Path = DEFAULT_OUTPUT) -> dict[str, Any]:
    """Write the generated preview bundle and return its inspectable summary."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    view = build_view()
    encoded = json.dumps(view, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    encoded = encoded.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    sidecar_url = _sidecar_url()
    html = TEMPLATE.read_text(encoding="utf-8").replace("__VIEW_JSON__", encoded)
    html = html.replace("__SIDECAR_URL__", json.dumps(sidecar_url, ensure_ascii=False))
    (output_dir / "index.html").write_text(html, encoding="utf-8")
    if not CHART_VENDOR.is_file():
        raise FileNotFoundError("bundled Lightweight Charts vendor is missing; run npm ci")
    for name in ("styles.css", "dashboard-core.js", "app.js", "tqr-logo.svg"):
        shutil.copyfile(SOURCE_DIR / name, output_dir / name)
    shutil.copyfile(CHART_VENDOR, output_dir / "lightweight-charts.js")
    return {
        "output_dir": str(output_dir),
        "files": sorted(path.name for path in output_dir.iterdir() if path.is_file()),
        "schema": view["schema"],
        "read_only": view["read_only"],
        "as_of": view["as_of"],
        "view_digest": view["view_digest"],
        "product_count": len(view["products"]),
        "feature_count": len(view["features"]),
    }


if __name__ == "__main__":
    print(json.dumps(build_preview(), ensure_ascii=False, sort_keys=True))
