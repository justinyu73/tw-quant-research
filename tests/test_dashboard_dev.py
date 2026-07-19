import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from run_dashboard_dev import collect_report  # noqa: E402


class DashboardDevTests(unittest.TestCase):
    def test_dev_surface_is_connected_and_read_only(self) -> None:
        report = collect_report(serve_loopback=False)
        self.assertEqual(report["status"], "pass", json.dumps(report, ensure_ascii=False, sort_keys=True))
        self.assertFalse(report["scope"]["provider_calls"])
        self.assertFalse(report["scope"]["write_routes"])
        self.assertTrue(all(report["checks"].values()))


if __name__ == "__main__":
    unittest.main()
