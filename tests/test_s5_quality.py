import copy
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.corporate_actions import (  # noqa: E402
    ADJUSTMENT_POLICY,
    CorporateActionError,
    PRICE_MULTIPLIER_CONVENTION,
    adjust_close,
    adjust_ohlcv,
)
from tw_quant_engine.data_contract import PointInTimeDataset  # noqa: E402
from tw_quant_engine.quality_checks import check_records  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s5/corporate-actions.json"


class S5QualityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.records = cls.payload["records"]
        cls.provenance = cls.payload["provenance"]
        cls.actions = [row for row in cls.records if row["record_type"] == "corporate_action"]

    def test_fixture_quality_is_green(self) -> None:
        report = check_records(self.records, self.provenance)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["issues"], [])

    def test_point_in_time_hides_action_before_available_at(self) -> None:
        dataset = PointInTimeDataset(self.records, self.provenance)
        before = dataset.as_of("2025-12-19T23:59:59Z")
        after = dataset.as_of("2025-12-20T11:00:00Z")
        self.assertFalse(any(row["record_type"] == "corporate_action" for row in before))
        self.assertTrue(any(row["record_type"] == "corporate_action" for row in after))

    def test_forward_price_adjustment_respects_ex_date_boundary(self) -> None:
        before = adjust_close(
            100,
            "2026-01-02",
            self.actions,
            convention=PRICE_MULTIPLIER_CONVENTION,
            as_of="2026-01-06T00:00:00Z",
        )
        on_ex_date = adjust_close(
            50,
            "2026-01-05",
            self.actions,
            convention=PRICE_MULTIPLIER_CONVENTION,
            as_of="2026-01-06T00:00:00Z",
        )
        self.assertEqual(before["raw_close"], 100.0)
        self.assertEqual(before["adjustment_factor"], 0.5)
        self.assertEqual(before["adjusted_close"], 50.0)
        self.assertEqual(on_ex_date["adjustment_factor"], 1.0)
        self.assertEqual(on_ex_date["adjusted_close"], 50.0)

    def test_action_not_visible_at_as_of_does_not_adjust(self) -> None:
        result = adjust_close(
            100,
            "2026-01-02",
            self.actions,
            convention=PRICE_MULTIPLIER_CONVENTION,
            as_of="2025-12-19T23:59:59Z",
        )
        self.assertEqual(result["adjustment_factor"], 1.0)
        self.assertEqual(result["adjusted_close"], 100.0)

    def test_adjusted_ohlcv_keeps_raw_and_inverts_split_volume(self) -> None:
        result = adjust_ohlcv(
            {"open": 100, "high": 101, "low": 99, "close": 100, "volume": 1000},
            "2026-01-02",
            self.actions,
            convention=PRICE_MULTIPLIER_CONVENTION,
            as_of="2026-07-19T23:59:59+08:00",
        )
        self.assertEqual(result["raw_ohlcv"]["close"], 100.0)
        self.assertEqual(result["adjusted_ohlcv"]["close"], 50.0)
        self.assertEqual(result["adjusted_ohlcv"]["volume"], 2000.0)
        self.assertEqual(result["price_adjustment_factor"], 0.5)
        self.assertEqual(result["volume_adjustment_factor"], 2.0)
        self.assertEqual(result["adjustment_policy"], ADJUSTMENT_POLICY)

    def test_adjusted_ohlcv_rejects_unknown_volume_policy(self) -> None:
        unknown = copy.deepcopy(self.actions[0])
        unknown["action_type"] = "rights_issue"
        with self.assertRaises(CorporateActionError):
            adjust_ohlcv(
                {"open": 100, "high": 101, "low": 99, "close": 100, "volume": 1000},
                "2026-01-02",
                [unknown],
                convention=PRICE_MULTIPLIER_CONVENTION,
                as_of="2026-07-19T23:59:59+08:00",
            )

    def test_ambiguous_factor_convention_fails_closed(self) -> None:
        with self.assertRaises(CorporateActionError):
            adjust_close(
                100,
                "2026-01-02",
                self.actions,
                convention="unknown_factor_direction",
                as_of="2026-01-06T00:00:00Z",
            )

    def test_bad_price_and_source_conflict_fail_closed(self) -> None:
        bad_price = copy.deepcopy(self.records[1])
        bad_price["volume"] = -1
        report = check_records([bad_price], [self.provenance[1]])
        self.assertEqual(report["status"], "invalid")
        self.assertTrue(any(issue["code"] == "invalid_record" for issue in report["issues"]))

        conflict = copy.deepcopy(self.records[2])
        conflict["snapshot_id"] = "s5-conflicting-source"
        conflict["source_ref"] = "synthetic://other-source/price"
        conflict["close"] = 50.5
        conflict_provenance = copy.deepcopy(self.provenance)
        conflict_provenance.append(
            {
                "source_id": "other-source",
                "snapshot_id": "s5-conflicting-source",
                "retrieved_at": "2026-01-05T10:00:00Z",
                "content_digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
                "schema_version": "s5-fixture/v1",
                "license_ref": "https://data.gov.tw/license",
            }
        )
        conflict["available_at"] = "2026-01-05T14:00:00+08:00"
        report = check_records(self.records + [conflict], conflict_provenance)
        self.assertEqual(report["status"], "conflict")
        self.assertTrue(any(issue["code"] == "source_conflict" for issue in report["issues"]))

    def test_quality_checks_are_offline(self) -> None:
        with patch.object(socket, "socket", side_effect=AssertionError("network is forbidden in S5")):
            report = check_records(self.records, self.provenance)
        self.assertEqual(report["status"], "pass")


if __name__ == "__main__":
    unittest.main()
