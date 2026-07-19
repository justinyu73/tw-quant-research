import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import p5_execution_target  # noqa: E402


class P5ExecutionTargetTests(unittest.TestCase):
    def test_target_is_located_but_waits_for_human_gate(self) -> None:
        result = p5_execution_target.run(ROOT)
        self.assertEqual(result["status"], "blocked_source_contract")
        self.assertFalse(result["execution_ready"])
        self.assertEqual(result["provider_calls"], 0)
        self.assertEqual(result["preparation_step"], "p5_2_validate_preapproved_corporate_action_fixture")
        self.assertTrue(all(result["checks"].values()))
        self.assertTrue(result["checks"]["work_unit_digest_is_fail_closed_template"])
        self.assertNotIn("preapproved_corporate_action_fixture_and_factor_provenance", result["pending_gates"])
        self.assertEqual(
            result["pending_gates"],
            [
                "p5_1_official_twse_three_year_bulk_and_calendar_contract",
                "p5_3_exact_human_run_work_unit_digest",
            ],
        )

    def test_source_contract_does_not_admit_a_candidate(self) -> None:
        contract = json.loads(
            (ROOT / "workflow/tqe-p5-twse-source-contract.json").read_text(encoding="utf-8")
        )
        self.assertEqual(contract["status"], "source_contract_blocked")
        self.assertIsNone(contract["selected_source"])
        self.assertEqual(contract["provider_calls_made_by_repository"], 0)
        self.assertEqual(
            contract["resolution_audit"]["result"],
            "no_official_bounded_bulk_artifact_found",
        )

    def test_workflow_scope_defers_us_and_new_provider(self) -> None:
        workflow = json.loads((ROOT / "workflow/tqe-p5-history-admission.json").read_text(encoding="utf-8"))
        self.assertIn("TWSE", workflow["human_selection"]["source_market_scope"]["in_scope"])
        self.assertIn("TPEx", workflow["human_selection"]["source_market_scope"]["in_scope"])
        self.assertEqual(
            workflow["human_selection"]["source_market_scope"]["deferred_scope"],
            ["US_equity", "new_provider", "general_provider_runtime"],
        )

    def test_preflight_is_deterministic_and_does_not_write(self) -> None:
        before = (ROOT / "workflow/tqe-p5-history-admission.json").read_bytes()
        first = p5_execution_target.run(ROOT)
        second = p5_execution_target.run(ROOT)
        after = (ROOT / "workflow/tqe-p5-history-admission.json").read_bytes()
        self.assertEqual(first, second)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
