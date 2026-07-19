import sys
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.qlib_spike import fixture_digest, run_qlib_spike, synthetic_fixture


class QlibSpikeTests(unittest.TestCase):
    def test_synthetic_fixture_is_stable(self) -> None:
        self.assertEqual(len(synthetic_fixture()), 8)
        self.assertEqual(
            fixture_digest(),
            "sha256:d581f39822db2d4beb924e0c47559963f37a9e048c64a14b0f07da9ef1accf74",
        )

    @unittest.skipUnless(
        importlib.util.find_spec("qlib"),
        "optional Qlib dependency is not installed",
    )
    def test_qlib_evaluation_call_is_green(self) -> None:
        result = run_qlib_spike()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["qlib_version"], "0.9.7")
        self.assertFalse(result["provider_initialized"])
        self.assertFalse(result["network_used"])
        self.assertIn("max_drawdown", result["risk_metrics"])


if __name__ == "__main__":
    unittest.main()
