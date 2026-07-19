import copy
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.features import build_feature_rows, feature_digest  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s6/features.json"


class S6FeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def build(self, *, as_of: str = "2026-01-10T00:00:00Z") -> list[dict]:
        return build_feature_rows(
            self.payload["records"],
            self.payload["provenance"],
            as_of=as_of,
        )

    def test_as_of_hides_future_trading_date(self) -> None:
        rows = self.build()
        self.assertEqual(len(rows), 6)
        self.assertNotIn("2026-01-12", {row["trading_date"] for row in rows})

    def test_exact_five_observation_features(self) -> None:
        row = next(item for item in self.build() if item["trading_date"] == "2026-01-09")
        self.assertAlmostEqual(row["features"]["return_5d"]["value"], 0.05)
        self.assertAlmostEqual(row["features"]["volume_mean_5d"]["value"], 400.0)
        returns = [101 / 100 - 1, 102 / 101 - 1, 103 / 102 - 1, 104 / 103 - 1, 105 / 104 - 1]
        expected_volatility = (sum((value - sum(returns) / len(returns)) ** 2 for value in returns) / len(returns)) ** 0.5
        self.assertAlmostEqual(row["features"]["volatility_5d"]["value"], expected_volatility)
        self.assertEqual(row["price_basis"], "close_raw")

    def test_insufficient_windows_are_explicit_and_not_filled(self) -> None:
        first = next(item for item in self.build() if item["trading_date"] == "2026-01-02")
        self.assertIsNone(first["features"]["return_1d"]["value"])
        self.assertEqual(first["features"]["return_1d"]["reason"], "insufficient_window")
        self.assertIsNone(first["features"]["return_5d"]["value"])
        self.assertEqual(first["features"]["return_5d"]["reason"], "insufficient_window")
        self.assertIsNone(first["features"]["volume_mean_5d"]["value"])

    def test_future_record_does_not_leak_even_if_available_before_cutoff(self) -> None:
        payload = copy.deepcopy(self.payload)
        future = payload["records"][-1]
        future["available_at"] = "2026-01-09T15:00:00+08:00"
        rows = build_feature_rows(payload["records"], payload["provenance"], as_of="2026-01-10T00:00:00Z")
        self.assertNotIn("2026-01-12", {row["trading_date"] for row in rows})

    def test_snapshot_lineage_and_determinism(self) -> None:
        first = self.build()
        second = self.build()
        self.assertEqual(feature_digest(first), feature_digest(second))
        last = next(row for row in first if row["trading_date"] == "2026-01-09")
        self.assertEqual(last["formula_version"], "s6-v1")
        self.assertEqual(len(last["features"]["return_5d"]["source_snapshot_ids"]), 6)

    def test_feature_pipeline_is_offline(self) -> None:
        with patch.object(socket, "socket", side_effect=AssertionError("S6 network is forbidden")):
            rows = self.build()
        self.assertEqual(len(rows), 6)


if __name__ == "__main__":
    unittest.main()
