import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import p5_work_unit_digest  # noqa: E402


class P5WorkUnitDigestTests(unittest.TestCase):
    def test_template_digest_is_stable_but_not_activation_ready(self) -> None:
        result = p5_work_unit_digest.run(ROOT)
        self.assertEqual(result["status"], "blocked_source_contract")
        self.assertEqual(result["stage_id"], "P5.3")
        self.assertFalse(result["activation_ready"])
        self.assertEqual(result["provider_calls"], 0)
        self.assertTrue(all(result["checks"].values()))

    def test_digest_replay_is_deterministic(self) -> None:
        first = p5_work_unit_digest.run(ROOT)
        second = p5_work_unit_digest.run(ROOT)
        self.assertEqual(first["template_digest"], second["template_digest"])


if __name__ == "__main__":
    unittest.main()
