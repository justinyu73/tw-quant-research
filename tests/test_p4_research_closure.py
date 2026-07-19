import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from p4_research_closure import run_audit  # noqa: E402


class P4ResearchClosureTests(unittest.TestCase):
    def test_research_only_boundary_is_green(self) -> None:
        result = run_audit(ROOT)
        self.assertEqual(result["status"], "pass", result)
        self.assertTrue(all(result["checks"].values()))
        self.assertFalse(result["provider_calls"])
        self.assertFalse(result["live_trading"])
        self.assertFalse(result["write_routes"])
        self.assertEqual(result["human_gate"], "required_before_runtime_or_execution_promotion")


if __name__ == "__main__":
    unittest.main()
