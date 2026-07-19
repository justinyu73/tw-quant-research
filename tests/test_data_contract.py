import copy
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.data_contract import (  # noqa: E402
    ContractError,
    PointInTimeDataset,
    load_fixture,
)


FIXTURE_PATH = ROOT / "tests/fixtures/s2/pit_fixture.json"


class PointInTimeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.dataset = load_fixture(FIXTURE_PATH)

    def test_fixture_digest_is_stable(self) -> None:
        self.assertEqual(
            self.dataset.digest(),
            "sha256:adc14a20831067ad5d853541ddb116053bc4f277676070330cdfdbafaaf71510",
        )

    def test_future_fundamental_is_hidden(self) -> None:
        before_report = self.dataset.as_of("2024-02-09T23:59:59Z")
        self.assertFalse(any(row["record_type"] == "fundamental_observation" for row in before_report))

        after_report = self.dataset.as_of("2024-02-15T00:00:00Z")
        eps = [row for row in after_report if row["record_type"] == "fundamental_observation"]
        self.assertEqual(len(eps), 1)
        self.assertEqual(eps[0]["value"], 1.0)

    def test_restatement_replays_latest_visible_version(self) -> None:
        after_restatement = self.dataset.as_of("2024-03-02T00:00:00Z")
        eps = [row for row in after_restatement if row["record_type"] == "fundamental_observation"]
        self.assertEqual(len(eps), 1)
        self.assertEqual(eps[0]["value"], 1.2)
        self.assertEqual(eps[0]["snapshot_id"], "snapshot-v2")

    def test_corporate_action_is_explicit(self) -> None:
        rows = self.dataset.as_of("2024-01-11T00:00:00Z")
        actions = [row for row in rows if row["record_type"] == "corporate_action"]
        self.assertEqual(actions[0]["factor"], 0.5)
        self.assertEqual(actions[0]["action_type"], "split")

    def test_duplicate_canonical_key_is_rejected(self) -> None:
        records = copy.deepcopy(self.payload["records"])
        records.append(copy.deepcopy(records[0]))
        with self.assertRaisesRegex(ContractError, "duplicate canonical"):
            PointInTimeDataset.from_fixture(
                {"schema": self.payload["schema"], "records": records, "provenance": self.payload["provenance"]}
            )

    def test_naive_timestamp_is_rejected(self) -> None:
        records = copy.deepcopy(self.payload["records"])
        records[0]["available_at"] = "2024-01-05T06:30:00"
        with self.assertRaisesRegex(ContractError, "explicit timezone"):
            PointInTimeDataset.from_fixture(
                {"schema": self.payload["schema"], "records": records, "provenance": self.payload["provenance"]}
            )

    def test_unknown_snapshot_is_rejected(self) -> None:
        records = copy.deepcopy(self.payload["records"])
        records[0]["snapshot_id"] = "snapshot-unknown"
        with self.assertRaisesRegex(ContractError, "unknown snapshots"):
            PointInTimeDataset.from_fixture(
                {"schema": self.payload["schema"], "records": records, "provenance": self.payload["provenance"]}
            )


if __name__ == "__main__":
    unittest.main()
