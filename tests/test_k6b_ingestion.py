import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.adapters.taifex_openapi import map_taifex_daily_rows  # noqa: E402
from tw_quant_engine.k6b_snapshot import (  # noqa: E402
    AVAILABLE_AT_POLICY,
    K6bSnapshotError,
    TAIFEX_ASSET_CLASS,
    bars_digest_from_mapping,
    available_at_for_trading_date,
    load_snapshot,
    map_taifex_rows,
    normalize_contract_month,
    parse_taifex_trading_date,
)
from tw_quant_engine.kline_aggregation import aggregate_dataset  # noqa: E402
from tw_quant_engine.kline_contract import KlineFixture  # noqa: E402
from tw_quant_engine.kline_view import build_kline_read_model  # noqa: E402


SNAPSHOT_DIR = ROOT / "tests/fixtures/k6b"
SNAPSHOT_NAME = "taifex_daily_fut-TX-202608-2026-07-15.json.gz"
EXPECTED_ROW_COUNTS = {
    "raw": 2309,
    "admitted": 1,
    "unadmitted": 2308,
    "excluded_by_reason": {
        "excluded_after_hours": 1,
        "excluded_other_contract": 2291,
        "excluded_other_contract_month": 10,
        "excluded_spread": 6,
    },
    "category_counts": {
        "tx_rows": 18,
        "target_contract_month_rows": 2,
        "tx_regular_rows": 11,
        "tx_after_hours_rows": 7,
        "target_regular_rows": 1,
        "target_after_hours_rows": 1,
        "spread_rows": 6,
        "other_contract_month_rows": 10,
        "other_contract_rows": 2291,
        "settlement_zero_rows": 1,
        "settlement_zero_target_contract_month_rows": 0,
        "admitted_regular_rows": 1,
    },
}
EXPECTED_BARS_DIGEST = "sha256:9564b6a3fb4bfdf9dc34bfbbfcbaf081ab0b011e56f9aedf7514795fd51dcf95"


def _row(**overrides: str) -> dict[str, str]:
    row = {
        "Date": "20260715",
        "Contract": "TX",
        "ContractMonth(Week)": "202608",
        "Open": "45652",
        "High": "46169",
        "Low": "45406",
        "Last": "46050",
        "Volume": "45252",
        "SettlementPrice": "46066",
        "TradingSession": "一般",
    }
    row.update(overrides)
    return row


class K6bIngestionTests(unittest.TestCase):
    def test_contract_and_date_normalization_are_explicit(self) -> None:
        self.assertEqual(normalize_contract_month("202608"), "202608")
        self.assertEqual(parse_taifex_trading_date("20260715"), "2026-07-15")
        self.assertEqual(parse_taifex_trading_date("2026-07-15"), "2026-07-15")
        with self.assertRaises(K6bSnapshotError):
            normalize_contract_month("2026-8")

    def test_available_at_policy_is_taipei_aware(self) -> None:
        self.assertEqual(AVAILABLE_AT_POLICY, "trading_date_at_15:00:00_Asia/Taipei")
        self.assertEqual(available_at_for_trading_date("2026-07-15"), "2026-07-15T15:00:00+08:00")

    def test_only_target_tx_regular_row_is_admitted(self) -> None:
        rows = [
            _row(),
            _row(TradingSession="盤後", SettlementPrice="NULL", Open="-"),
            _row(**{"ContractMonth(Week)": "202608/202609"}),
            _row(**{"ContractMonth(Week)": "202609"}),
            _row(Contract="TXO"),
        ]
        result = map_taifex_daily_rows(rows, "2026-07-15", "202608")
        self.assertEqual(result["admitted_count"], 1)
        self.assertEqual(result["excluded_by_reason"]["excluded_after_hours"], 1)
        self.assertEqual(result["excluded_by_reason"]["excluded_spread"], 1)
        self.assertEqual(result["excluded_by_reason"]["excluded_other_contract_month"], 1)
        self.assertEqual(result["excluded_by_reason"]["excluded_other_contract"], 1)
        dataset = result["datasets"][0]
        self.assertEqual(dataset["instrument"]["asset_class"], TAIFEX_ASSET_CLASS)
        self.assertEqual(dataset["instrument"]["contract_month"], "202608")
        self.assertIsNone(dataset["instrument"]["expiry"])
        self.assertEqual(dataset["quality"], {"status": "partial", "reason_codes": ["expiry_not_in_source"]})
        self.assertEqual(result["contract_metadata"]["settlement_price"], 46066)

    def test_after_hours_is_excluded_before_ohlcv_or_settlement_checks(self) -> None:
        result = map_taifex_rows(
            [_row(TradingSession="盤後", SettlementPrice="NULL", Open="-")],
            trading_date="2026-07-15",
            contract_month="202608",
        )
        self.assertEqual(result["admitted_count"], 0)
        self.assertEqual(result["unadmitted_rows"][0]["reason_codes"], ["excluded_after_hours"])

    def test_zero_settlement_is_fail_closed(self) -> None:
        result = map_taifex_rows(
            [_row(SettlementPrice="0")],
            trading_date="2026-07-15",
            contract_month="202608",
        )
        self.assertEqual(result["admitted_count"], 0)
        self.assertEqual(result["excluded_by_reason"], {"settlement_zero": 1})
        self.assertEqual(result["category_counts"]["settlement_zero_target_contract_month_rows"], 1)

    def test_source_date_mismatch_is_fail_closed(self) -> None:
        result = map_taifex_rows(
            [_row(Date="20260716")],
            trading_date="2026-07-15",
            contract_month="202608",
        )
        self.assertEqual(result["admitted_count"], 0)
        self.assertIn("source_trading_date_mismatch", result["unadmitted_rows"][0]["reason_codes"])

    def test_committed_snapshot_is_k1_input_and_preserves_future_semantics(self) -> None:
        paths = sorted(SNAPSHOT_DIR.glob("*.json.gz"))
        self.assertEqual({path.name for path in paths}, {SNAPSHOT_NAME})
        snapshot = load_snapshot(paths[0])
        self.assertEqual(snapshot["row_counts"], EXPECTED_ROW_COUNTS)
        self.assertEqual(snapshot["contract"], "TX")
        self.assertEqual(snapshot["contract_month"], "202608")
        self.assertEqual(snapshot["asset_class"], "future")
        self.assertIsNone(snapshot["expiry"])
        self.assertEqual(snapshot["expiry_reason"], "expiry_not_in_source")
        self.assertEqual(snapshot["available_at"], "2026-07-15T15:00:00+08:00")
        self.assertRegex(snapshot["content_digest"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(snapshot["content_digest"], snapshot["source_metadata"]["content_digest"])
        fixture = KlineFixture.from_payload(snapshot["kline_fixture"])
        self.assertFalse(fixture.payload["provenance"]["network"])
        self.assertFalse(fixture.payload["provenance"]["provider_calls"])
        self.assertEqual(fixture.datasets[0]["quality"]["reason_codes"], ["expiry_not_in_source"])
        self.assertEqual(fixture.datasets[0]["instrument"]["expiry"], None)
        self.assertEqual(snapshot["bars_digest"], EXPECTED_BARS_DIGEST)
        self.assertEqual(snapshot["bars_digest"], bars_digest_from_mapping({"datasets": fixture.datasets}))

    def test_snapshot_feeds_existing_k2_k3_without_network(self) -> None:
        snapshot = load_snapshot(SNAPSHOT_DIR / SNAPSHOT_NAME)
        fixture = KlineFixture.from_payload(snapshot["kline_fixture"])
        dataset = fixture.datasets[0]
        aggregation = aggregate_dataset(dataset, period="1D", as_of=fixture.as_of)
        self.assertEqual(aggregation["quality"]["status"], "valid")
        model = build_kline_read_model(aggregation)
        self.assertTrue(model["read_only"])
        self.assertEqual(model["instrument"]["asset_class"], "future")

if __name__ == "__main__":
    unittest.main()
