import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import p5_corporate_action_validation  # noqa: E402


class P5CorporateActionValidationTests(unittest.TestCase):
    def test_preapproved_fixture_passes_without_provider_calls(self) -> None:
        result = p5_corporate_action_validation.run(ROOT)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["stage_id"], "P5.2")
        self.assertFalse(result["network"])
        self.assertEqual(result["provider_calls"], 0)
        self.assertTrue(all(result["checks"].values()))

    def test_fixture_and_evidence_digests_are_pinned(self) -> None:
        result = p5_corporate_action_validation.run(ROOT)
        self.assertEqual(
            result["fixture"]["raw_file_digest"],
            p5_corporate_action_validation.APPROVED_RAW_FILE_DIGEST,
        )
        self.assertEqual(
            result["fixture"]["pit_digest"],
            p5_corporate_action_validation.APPROVED_PIT_DIGEST,
        )

    def test_validator_is_read_only_and_deterministic(self) -> None:
        before = (ROOT / "tests/fixtures/s5/corporate-actions.json").read_bytes()
        first = p5_corporate_action_validation.run(ROOT)
        second = p5_corporate_action_validation.run(ROOT)
        after = (ROOT / "tests/fixtures/s5/corporate-actions.json").read_bytes()
        self.assertEqual(first, second)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
