import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import p5_work_unit_digest  # noqa: E402


class P5WorkUnitDigestTests(unittest.TestCase):
    def test_approved_digest_replays_and_is_execution_ready(self) -> None:
        result = p5_work_unit_digest.run(ROOT)
        self.assertEqual(result["status"], "approved_pending_execution")
        self.assertEqual(result["stage_id"], "P5.3")
        self.assertTrue(result["activation_ready"])
        self.assertEqual(result["provider_calls"], 0)
        self.assertTrue(all(result["checks"].values()))
        self.assertTrue(result["checks"]["source_contract_is_fail_closed"])
        self.assertTrue(result["checks"]["approved_digest_replays"])

    def test_digest_replay_is_deterministic(self) -> None:
        first = p5_work_unit_digest.run(ROOT)
        second = p5_work_unit_digest.run(ROOT)
        self.assertEqual(first["template_digest"], second["template_digest"])


if __name__ == "__main__":
    unittest.main()
