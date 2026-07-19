import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.adapters.tpex_openapi import map_tpex_daily_rows  # noqa: E402
from tw_quant_engine.adapters.twse_openapi import map_twse_daily_rows  # noqa: E402
from tw_quant_engine.k6a_snapshot import (  # noqa: E402
    AVAILABLE_AT_POLICY,
    K6aSnapshotError,
    available_at_for_trading_date,
    bars_digest_from_mapping,
    classify_taiwan_asset_class,
    load_snapshot,
    roc_trading_date,
)
from tw_quant_engine.kline_aggregation import aggregate_dataset  # noqa: E402
from tw_quant_engine.kline_contract import KlineFixture  # noqa: E402
from tw_quant_engine.kline_view import build_kline_read_model  # noqa: E402


SNAPSHOT_DIR = ROOT / "tests/fixtures/k6a"
EXPECTED_SNAPSHOTS = {
    "twse_daily_close-2026-07-15.json.gz": {
        "row_counts": {
            "raw": 1370,
            "admitted": 1315,
            "unadmitted": 55,
            "admitted_by_asset_class": {"equity": 1082, "etf": 233},
            "excluded_by_reason": {"unknown_asset_class": 55},
        },
        "bars_digest": "sha256:4e6911898fadbe4e2e295557022d9399a51feba58a62bb6a7b8e0206de64cb1d",
    },
    "tpex_daily_close-2026-07-16.json.gz": {
        "row_counts": {
            "raw": 10088,
            "admitted": 984,
            "unadmitted": 9104,
            "admitted_by_asset_class": {"equity": 869, "etf": 115},
            "excluded_by_reason": {
                "excluded_warrant": 9075,
                "missing_or_invalid_ohlcv": 21,
                "unknown_asset_class": 8,
            },
        },
        "bars_digest": "sha256:ea3e122479d141a5bd2da475cdcf21657c8e240a9d4c843f71a5c721be971f47",
    },
    "twse_2330_history-2025-2026.json.gz": {
        "row_counts": {
            "raw": 359,
            "admitted": 1,
            "unadmitted": 0,
            "admitted_by_asset_class": {"equity": 1},
            "excluded_by_reason": {},
        },
        "bars_digest": "sha256:dfae64b3da14e08932da71390a1aa6e11e3ab7ca9fc8e29bf5b0b92c921af5d2",
    },
}


class K6aIngestionTests(unittest.TestCase):
    def test_asset_class_rules_are_explicit_and_fail_closed(self) -> None:
        self.assertEqual(classify_taiwan_asset_class("2330"), ("equity", None))
        self.assertEqual(classify_taiwan_asset_class("0050"), ("etf", None))
        self.assertEqual(classify_taiwan_asset_class("00679B"), ("etf", None))
        self.assertEqual(classify_taiwan_asset_class("72485U"), (None, "excluded_warrant"))
        self.assertEqual(classify_taiwan_asset_class("020025"), (None, "unknown_asset_class"))

    def test_available_at_policy_is_explicit_and_timezone_aware(self) -> None:
        self.assertEqual(AVAILABLE_AT_POLICY, "trading_date_at_15:00:00_Asia/Taipei")
        self.assertEqual(available_at_for_trading_date("2026-07-15"), "2026-07-15T15:00:00+08:00")
        self.assertEqual(roc_trading_date("2026-07-15"), "115/07/15")

    def test_twse_full_row_mapping_uses_policy_and_replays_deterministically(self) -> None:
        rows = [
            {
                "Date": "1150715",
                "Code": "2330",
                "Name": "台積電",
                "TradeVolume": "1,000",
                "OpeningPrice": "100",
                "HighestPrice": "110",
                "LowestPrice": "99",
                "ClosingPrice": "108",
            }
        ]
        first = map_twse_daily_rows(rows, "2026-07-15")
        replay = map_twse_daily_rows(json.loads(json.dumps(rows)), "2026-07-15")
        self.assertEqual(first["admitted_count"], 1)
        self.assertEqual(first["admitted_by_asset_class"], {"equity": 1, "etf": 0})
        self.assertEqual(first["datasets"][0]["bars"][0]["available_at"], "2026-07-15T15:00:00+08:00")
        self.assertEqual(bars_digest_from_mapping(first), bars_digest_from_mapping(replay))

    def test_tpex_full_row_mapping_fails_closed_for_date_mismatch(self) -> None:
        rows = [
            {
                "Date": "1150714",
                "SecuritiesCompanyCode": "6488",
                "CompanyName": "環球晶",
                "TradingShares": "500",
                "Open": "10",
                "High": "11",
                "Low": "9",
                "Close": "10.5",
            }
        ]
        result = map_tpex_daily_rows(rows, "2026-07-15")
        self.assertEqual(result["admitted_count"], 0)
        self.assertIn("source_trading_date_mismatch", result["unadmitted_rows"][0]["reason_codes"])

    def test_warrant_is_excluded_before_ohlcv_validation(self) -> None:
        rows = [
            {
                "Date": "1150715",
                "SecuritiesCompanyCode": "72485U",
                "CompanyName": "權證",
                "TradingShares": "--",
                "Open": "--",
                "High": "--",
                "Low": "--",
                "Close": "--",
            }
        ]
        result = map_tpex_daily_rows(rows, "2026-07-15")
        self.assertEqual(result["admitted_count"], 0)
        self.assertEqual(result["excluded_by_reason"], {"excluded_warrant": 1})
        self.assertEqual(result["unadmitted_rows"][0]["reason_codes"], ["excluded_warrant"])

    def test_missing_source_date_is_unadmitted_not_inferred(self) -> None:
        rows = [
            {
                "Code": "2330",
                "Name": "台積電",
                "TradeVolume": "1000",
                "OpeningPrice": "100",
                "HighestPrice": "110",
                "LowestPrice": "99",
                "ClosingPrice": "108",
            }
        ]
        result = map_twse_daily_rows(rows, "2026-07-15")
        self.assertEqual(result["admitted_count"], 0)
        self.assertIn("missing_source_trading_date", result["unadmitted_rows"][0]["reason_codes"])

    def test_committed_snapshots_are_k1_inputs_and_preserve_source_metadata(self) -> None:
        paths = sorted(SNAPSHOT_DIR.glob("*.json.gz"))
        self.assertGreaterEqual(len(paths), 2)
        self.assertEqual({path.name for path in paths}, set(EXPECTED_SNAPSHOTS))
        for path in paths:
            snapshot = load_snapshot(path)
            expected = EXPECTED_SNAPSHOTS[path.name]
            self.assertEqual(snapshot["available_at_policy"], AVAILABLE_AT_POLICY)
            self.assertEqual(snapshot["available_at"], f'{snapshot["trading_date"]}T15:00:00+08:00')
            self.assertRegex(snapshot["content_digest"], r"^sha256:[0-9a-f]{64}$")
            self.assertEqual(snapshot["content_digest"], snapshot["source_metadata"]["content_digest"])
            fixture = KlineFixture.from_payload(snapshot["kline_fixture"])
            self.assertFalse(fixture.payload["provenance"]["network"])
            self.assertFalse(fixture.payload["provenance"]["provider_calls"])
            self.assertEqual(snapshot["row_counts"]["admitted"], len(fixture.datasets))
            self.assertEqual(snapshot["row_counts"], expected["row_counts"])
            self.assertEqual(snapshot["bars_digest"], expected["bars_digest"])
            self.assertEqual(snapshot["bars_digest"], bars_digest_from_mapping({"datasets": fixture.datasets}))
            self.assertTrue(all(dataset["instrument"]["asset_class"] in {"equity", "etf"} for dataset in fixture.datasets))
            self.assertNotIn("warrant", {dataset["instrument"]["asset_class"] for dataset in fixture.datasets})

    def test_committed_snapshots_feed_existing_k2_k3_without_network(self) -> None:
        for path in sorted(SNAPSHOT_DIR.glob("*.json.gz")):
            snapshot = load_snapshot(path)
            fixture = KlineFixture.from_payload(snapshot["kline_fixture"])
            dataset = fixture.datasets[0]
            aggregation = aggregate_dataset(dataset, period="1D", as_of=fixture.as_of)
            self.assertEqual(aggregation["quality"]["status"], "valid")
            model = build_kline_read_model(aggregation)
            self.assertTrue(model["read_only"])
            self.assertEqual(model["instrument"]["market"], dataset["instrument"]["market"])

    def test_invalid_cli_date_fails_closed(self) -> None:
        with self.assertRaises(K6aSnapshotError):
            available_at_for_trading_date("not-a-date")


if __name__ == "__main__":
    unittest.main()
