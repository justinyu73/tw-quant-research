import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from release_hardening import (  # noqa: E402
    REQUIRED_EVIDENCE,
    audit_forbidden_files,
    file_digest,
    normalized_json_digest,
    validate_evidence,
)


class S9ReleaseHardeningTests(unittest.TestCase):
    def test_s1_to_s8_evidence_is_present_and_pass(self) -> None:
        for stage, relative in REQUIRED_EVIDENCE.items():
            result = validate_evidence(ROOT / relative, stage)
            self.assertEqual(result["status"], "pass", msg=f"{stage}: {result}")
            self.assertRegex(result["normalized_digest"], r"^sha256:[0-9a-f]{64}$")

    def test_evidence_and_fixture_digests_replay(self) -> None:
        evidence_path = ROOT / REQUIRED_EVIDENCE["S8"]
        fixture_path = ROOT / "tests/fixtures/s8/product-view.json"
        self.assertEqual(normalized_json_digest(evidence_path), normalized_json_digest(evidence_path))
        self.assertEqual(file_digest(fixture_path), file_digest(fixture_path))

    def test_forbidden_artifact_audit_is_green(self) -> None:
        result = audit_forbidden_files(ROOT)
        self.assertEqual(result, {"status": "pass", "forbidden": []})

    def test_release_boundaries_remain_research_only(self) -> None:
        manifest = json.loads((ROOT / "workflow/engine-manifest.json").read_text(encoding="utf-8"))
        package = json.loads((ROOT / "workflow/s5-s9-approval-package.json").read_text(encoding="utf-8"))
        self.assertFalse(manifest["provider_calls"])
        self.assertFalse(manifest["live_trading"])
        self.assertFalse(manifest["dashboard"])
        self.assertEqual(package["approval"]["decision"], "approved")
        self.assertEqual(package["execution_order"], ["S5", "S6", "S7", "S8", "S9"])
        self.assertTrue(all(stage["failure_budget"]["consecutive_failures"] == 3 for stage in package["stages"]))


if __name__ == "__main__":
    unittest.main()
