import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.data_update import DATA_MANIFEST_SCHEMA, update_twse_history, update_twse_watchlist  # noqa: E402
from tw_quant_engine.desktop_sidecar import load_catalog  # noqa: E402


class DataUpdateTests(unittest.TestCase):
    def test_selected_twse_history_writes_raw_and_normalized_local_data(self) -> None:
        calls: list[str] = []

        def fake_fetcher(request: Request) -> tuple[bytes, int, str]:
            query = parse_qs(urlsplit(request.full_url).query)
            month = query["date"][0]
            calls.append(month)
            year = int(month[:4])
            month_number = int(month[4:6])
            roc_year = year - 1911
            payload = {
                "stat": "OK",
                "fields": ["日期", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數"],
                "data": [[f"{roc_year:03d}/{month_number:02d}/01", "1,000", "10,000", "10", "11", "9", "10.5", "0.5", "10"]],
            }
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), 200, "application/json"

        instrument = {
            "instrument_id": "TWSE:2308",
            "market": "TWSE",
            "symbol": "2308",
            "display_name": "台達電",
        }
        with tempfile.TemporaryDirectory(prefix="tqr-data-update-") as directory:
            result = update_twse_history(directory, instrument, 1, today=date(2026, 7, 20), fetcher=fake_fetcher)
            root = Path(directory)
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["months_requested"], 13)
            self.assertEqual(result["months_downloaded"], 13)
            self.assertEqual(result["bars_downloaded"], 13)
            self.assertEqual(len(calls), 13)
            self.assertTrue((root / "raw" / "twse" / "2308" / "2026-07.json").is_file())
            self.assertEqual(json.loads((root / "manifest.json").read_text())["schema"], DATA_MANIFEST_SCHEMA)
            catalog = load_catalog(ROOT / "tests" / "fixtures", data_dir=root)
            self.assertIn("TWSE:2308", {item["instrument_id"] for item in catalog.instruments})
            self.assertGreaterEqual(len(catalog.models[("TWSE:2308", "1D")]["bars"]), 13)

    def test_range_is_limited_to_one_two_or_three_years(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tqr-data-update-") as directory:
            with self.assertRaises(ValueError):
                update_twse_history(
                    directory,
                    {"instrument_id": "TWSE:2308", "market": "TWSE", "symbol": "2308"},
                    4,
                    today=date(2026, 7, 20),
                    fetcher=lambda _request: (_ for _ in ()).throw(AssertionError("fetch must not run")),
                )

    def test_watchlist_update_only_processes_requested_instruments_and_keeps_per_stock_status(self) -> None:
        calls: list[str] = []

        def fake_fetcher(request: Request) -> tuple[bytes, int, str]:
            query = parse_qs(urlsplit(request.full_url).query)
            month = query["date"][0]
            symbol = query["stockNo"][0]
            calls.append(symbol + ":" + month)
            year = int(month[:4])
            month_number = int(month[4:6])
            roc_year = year - 1911
            payload = {
                "stat": "OK",
                "fields": ["日期", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數"],
                "data": [[f"{roc_year:03d}/{month_number:02d}/01", "1,000", "10,000", "10", "11", "9", "10.5", "0.5", "10"]],
            }
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), 200, "application/json"

        instruments = [
            {"instrument_id": "TWSE:2308", "market": "TWSE", "symbol": "2308", "display_name": "台達電"},
            {"instrument_id": "TAIFEX:TX:202608", "market": "TAIFEX", "symbol": "TX", "display_name": "臺股期貨"},
        ]
        with tempfile.TemporaryDirectory(prefix="tqr-data-update-") as directory:
            result = update_twse_watchlist(directory, instruments, 1, today=date(2026, 7, 20), fetcher=fake_fetcher)
            self.assertEqual(result["scope"], "watchlist")
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["requested_count"], 2)
            self.assertEqual(result["updated_count"], 1)
            self.assertEqual(result["bars_downloaded"], 13)
            self.assertEqual([item["status"] for item in result["results"]], ["success", "unsupported"])
            self.assertEqual(len(calls), 13)


if __name__ == "__main__":
    unittest.main()
