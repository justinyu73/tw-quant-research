import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_dashboard_preview import build_preview, build_view  # noqa: E402


class K4KlineUiContractTests(unittest.TestCase):
    def test_preview_contains_bundled_kline_models_and_local_chart_asset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            summary = build_preview(Path(directory) / "preview")
            self.assertIn("lightweight-charts.js", summary["files"])
            self.assertIn("tqr-logo.svg", summary["files"])
            self.assertGreater((Path(directory) / "preview/lightweight-charts.js").stat().st_size, 100000)
            html = (Path(directory) / "preview/index.html").read_text(encoding="utf-8")
            app = (Path(directory) / "preview/app.js").read_text(encoding="utf-8")
        self.assertIn('./lightweight-charts.js', html)
        self.assertIn('data-testid="kline-chart"', app)

    def test_kline_controls_are_runtime_fetched_from_loopback_sidecar(self) -> None:
        view = build_view()
        self.assertEqual(view["kline"]["models"], [])
        self.assertEqual(view["kline"]["instruments"], [])
        self.assertTrue(view["kline"]["runtime_fetch"])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "preview"
            build_preview(output)
            app = (output / "app.js").read_text(encoding="utf-8").lower()
            template = (output / "index.html").read_text(encoding="utf-8").lower()
        for token in ("kline-chart", "kline-instrument", "kline-period", "kline-indicator", "kline-quality", "kline-coverage", "kline-empty", "technical-snapshot", "technical-value-", "valuation-panel", "valuation-eps", "valuation-pe-low", "valuation-pe-high", "valuation-safety-margin"):
            self.assertIn(token, app)
        self.assertIn("尚未套用個人計算規則", app)
        self.assertIn("不提供網路預設合理價", app)
        self.assertIn("fetch(", app)
        self.assertIn("http://127.0.0.1", app)
        self.assertNotIn("xmlhttprequest", app)
        self.assertNotIn("websocket", app)
        self.assertIn("lightweight-charts.js", template)

    def test_kline_digest_is_deterministic(self) -> None:
        first = build_view()
        second = build_view()
        self.assertEqual(first["kline_digest"], second["kline_digest"])
        self.assertTrue(first["kline_digest"].startswith("sha256:"))


if __name__ == "__main__":
    unittest.main()
