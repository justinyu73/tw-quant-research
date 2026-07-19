import copy
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.data_contract import PointInTimeDataset  # noqa: E402
from tw_quant_engine.ingestion import (  # noqa: E402
    load_s3_fixture,
    map_source_item,
    parse_roc_date,
    parse_roc_period_end,
)


S3_PATH = ROOT / "tests/fixtures/s3/source-admission.json"
SYNTHETIC_PATH = ROOT / "tests/fixtures/s4/synthetic-mapping.json"


class S4IngestionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.s3_payload = json.loads(S3_PATH.read_text(encoding="utf-8"))
        cls.synthetic_payload = json.loads(SYNTHETIC_PATH.read_text(encoding="utf-8"))

    def test_roc_dates_are_deterministic(self) -> None:
        self.assertEqual(parse_roc_date("1150715"), "2026-07-15")
        self.assertEqual(parse_roc_period_end("11506"), "2026-06-30")

    def test_live_s3_fixture_replays_without_network(self) -> None:
        def fail_socket(*args, **kwargs):
            raise AssertionError("S4 mapping attempted network access")

        with patch.object(socket, "socket", side_effect=fail_socket):
            results = load_s3_fixture(S3_PATH)
        self.assertEqual(len(results), 5)
        self.assertTrue(all(row["status"] == "unadmitted" for row in results))
        tpex = next(row for row in results if row["source_id"] == "tpex_daily_close")
        self.assertEqual(tpex["candidate_fields"]["volume"], 126283)
        self.assertIn("missing_source_available_at", tpex["reason_codes"])

    def test_missing_availability_and_unit_fail_closed(self) -> None:
        item = copy.deepcopy(self.synthetic_payload["items"][2])
        del item["sample_row"]["available_at"]
        del item["sample_row"]["unit"]
        result = map_source_item(item)
        self.assertEqual(result["status"], "unadmitted")
        self.assertIn("missing_source_available_at", result["reason_codes"])
        self.assertIn("missing_source_unit", result["reason_codes"])
        self.assertIsNone(result["record"])

    def test_timestamped_synthetic_rows_admit_to_s2(self) -> None:
        results = [map_source_item(item) for item in self.synthetic_payload["items"]]
        self.assertTrue(all(row["status"] == "admitted" for row in results))
        records = [row["record"] for row in results]
        provenance = []
        for row in results:
            item = row["provenance"]
            provenance.append(
                {
                    key: item[key]
                    for key in (
                        "source_id",
                        "snapshot_id",
                        "retrieved_at",
                        "content_digest",
                        "schema_version",
                        "license_ref",
                    )
                }
            )
        dataset = PointInTimeDataset(records, provenance)
        self.assertEqual(len(dataset.as_of("2026-07-20T00:00:00Z")), 6)
        self.assertEqual(records[0]["trading_date"], "2026-07-15")
        self.assertEqual(records[2]["period_end"], "2025-06-30")

    def test_network_guard_is_not_triggered_by_mapping(self) -> None:
        original = socket.socket

        def fail_socket(*args, **kwargs):
            raise AssertionError("offline S4 must not open a socket")

        socket.socket = fail_socket
        try:
            load_s3_fixture(S3_PATH)
        finally:
            socket.socket = original


if __name__ == "__main__":
    unittest.main()
