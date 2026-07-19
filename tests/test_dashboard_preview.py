import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_dashboard_preview import build_preview  # noqa: E402


class DashboardPreviewTests(unittest.TestCase):
    def test_preview_keeps_non_market_fixture_view_and_declares_loopback_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "preview"
            summary = build_preview(output)
            html = (output / "index.html").read_text(encoding="utf-8")
            browser_code = "\n".join((output / name).read_text(encoding="utf-8") for name in ("dashboard-core.js", "app.js"))
        self.assertTrue(summary["read_only"])
        self.assertEqual(summary["schema"], "tw-quant-engine-read-only-product-view/v1")
        self.assertIn("tw-quant-engine-read-only-product-view/v1", html)
        self.assertIn('href="./tqr-logo.svg"', html)
        self.assertIn("tqr-logo.svg", summary["files"])
        self.assertIn('window.__TW_QUANT_SIDECAR_URL__ = "http://127.0.0.1:8766";', html)
        lower = html.lower()
        self.assertIn("fetch(", browser_code.lower())
        self.assertIn("http://127.0.0.1", browser_code.lower())
        self.assertNotIn("xmlhttprequest", browser_code.lower())
        self.assertNotIn("websocket", browser_code.lower())
        self.assertNotIn("/orders", browser_code.lower())
        self.assertIn('role="dialog"', browser_code)
        self.assertIn('data-action="close-dialog"', browser_code)
        self.assertIn("Escape", browser_code)

    def test_preview_bundle_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = Path(first_dir) / "preview"
            second = Path(second_dir) / "preview"
            first_summary = build_preview(first)
            second_summary = build_preview(second)
            self.assertEqual(first_summary["view_digest"], second_summary["view_digest"])
            self.assertEqual(first_summary["files"], second_summary["files"])
            for name in first_summary["files"]:
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for browser interaction reducer validation")
    def test_interaction_reducer(self) -> None:
        result = subprocess.run(
            [shutil.which("node"), "tests/dashboard-core.test.cjs"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "pass")


if __name__ == "__main__":
    unittest.main()
