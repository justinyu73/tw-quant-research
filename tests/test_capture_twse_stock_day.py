import sys
import unittest

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from capture_twse_stock_day import bar_from_row, build_2330_snapshot, month_range  # noqa: E402


class CaptureTwseStockDayTests(unittest.TestCase):
    def test_month_range_is_explicit_and_bounded(self) -> None:
        self.assertEqual(month_range("2025-01", "2025-03"), ["2025-01", "2025-02", "2025-03"])
        with self.assertRaises(ValueError):
            month_range("2025-03", "2025-01")
        with self.assertRaises(ValueError):
            month_range("2020-01", "2024-01")

    def test_twse_roc_row_maps_to_contract_bar(self) -> None:
        bar = bar_from_row(["114/07/01", "52,818,889", "0", "1,080.00", "1,095.00", "1,075.00", "1,085.00"])
        self.assertEqual(bar["trading_date"], "2025-07-01")
        self.assertEqual(bar["close"], 1085)
        self.assertEqual(bar["volume"], 52818889)
        self.assertEqual(bar["available_at"], "2025-07-01T15:00:00+08:00")

    def test_snapshot_keeps_history_and_official_provenance(self) -> None:
        months = ["2025-07"]
        fetched = [{
            "month": "2025-07",
            "url": "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20250701&stockNo=2330&response=json",
            "http_status": 200,
            "response_bytes": 10,
            "content_digest": "sha256:test-month",
            "row_count": 2,
            "rows": [
                ["114/07/01", "52,818,889", "0", "1,080.00", "1,095.00", "1,075.00", "1,085.00"],
                ["114/07/02", "24,453,697", "0", "1,075.00", "1,085.00", "1,070.00", "1,085.00"],
            ],
        }]
        snapshot = build_2330_snapshot("2330", months, fetched, retrieved_at="2026-07-19T00:00:00Z")
        fixture = snapshot["kline_fixture"]
        dataset = fixture["datasets"][0]
        self.assertEqual(dataset["instrument"]["instrument_id"], "TWSE:2330")
        self.assertEqual(len(dataset["bars"]), 2)
        self.assertEqual(snapshot["source_metadata"]["endpoint"], "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY")
        self.assertEqual(snapshot["source_metadata"]["months"], months)
        self.assertFalse(fixture["provenance"]["network"])
        self.assertFalse(fixture["provenance"]["provider_calls"])


if __name__ == "__main__":
    unittest.main()
