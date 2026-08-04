import gzip
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

from tw_quant_engine.data_update import DATA_MANIFEST_SCHEMA, _fetch_tpex_day, update_tpex_history, update_twse_history, update_twse_watchlist  # noqa: E402
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

    def test_tpex_daily_response_date_mismatch_fails_closed(self) -> None:
        fixture_path = ROOT / "tests" / "fixtures" / "tpex" / "daily_quotes.sample.json"

        def fake_fetcher(request: Request) -> tuple[bytes, int, str]:
            self.assertEqual(request.get_method(), "POST")
            payload = json.loads(fixture_path.read_text(encoding="utf-8"))
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), 200, "application/json"

        with self.assertRaises(ValueError):
            _fetch_tpex_day("2026-07-20", fake_fetcher)

    def test_selected_tpex_history_writes_selected_raw_row_and_normalized_local_data(self) -> None:
        calls: list[str] = []
        fixture_path = ROOT / "tests" / "fixtures" / "tpex" / "daily_quotes.sample.json"

        def fake_fetcher(request: Request) -> tuple[bytes, int, str]:
            self.assertIn("dailyQuotes", request.full_url)
            form = parse_qs((request.data or b"").decode("utf-8"))
            trading_date = form["date"][0].replace("/", "-")
            calls.append(trading_date)
            payload = json.loads(fixture_path.read_text(encoding="utf-8"))
            payload["date"] = trading_date.replace("-", "")
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), 200, "application/json"

        with tempfile.TemporaryDirectory(prefix="tqr-data-update-") as directory:
            result = update_tpex_history(
                directory,
                {"instrument_id": "TPEx:5289", "market": "TPEx", "symbol": "5289", "display_name": "宜鼎"},
                1,
                today=date(2026, 7, 20),
                fetcher=fake_fetcher,
            )
            root = Path(directory)
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["months_requested"], 13)
            self.assertEqual(result["months_downloaded"], 13)
            self.assertEqual(result["bars_downloaded"], len(calls))
            self.assertGreater(len(calls), 200)
            raw_path = root / "raw" / "tpex" / "5289" / "2026-07-20.json"
            self.assertTrue(raw_path.is_file())
            raw_payload = json.loads(raw_path.read_text(encoding="utf-8"))
            self.assertEqual(raw_payload["capture_scope"], "selected_instrument_row_from_full_market_response")
            self.assertEqual(raw_payload["content_digest"].split(":", 1)[0], "sha256")
            self.assertEqual(raw_payload["payload"]["data"][0][0], "5289")
            snapshot_path = root / "k6a" / "tpex_daily_quotes-5289-2026-07-20.json.gz"
            with gzip.open(snapshot_path, "rt", encoding="utf-8") as handle:
                snapshot = json.load(handle)
            self.assertEqual(snapshot["source_id"], "tpex_daily_quotes")
            self.assertEqual(snapshot["source_metadata"]["attribution"], "資料來源：財團法人中華民國證券櫃檯買賣中心")
            self.assertEqual(snapshot["bars"][0]["volume"], 3323096)
            catalog = load_catalog(ROOT / "tests" / "fixtures", data_dir=root)
            self.assertIn("TPEx:5289", {item["instrument_id"] for item in catalog.instruments})
            self.assertEqual(catalog.models[("TPEx:5289", "1D")]["bars"][-1]["close"], 1415)

    def test_watchlist_update_only_processes_requested_instruments_and_reuses_tpex_daily_responses(self) -> None:
        calls: list[str] = []

        def fake_fetcher(request: Request) -> tuple[bytes, int, str]:
            self.assertIn("dailyQuotes", request.full_url)
            form = parse_qs((request.data or b"").decode("utf-8"))
            trading_date = form["date"][0].replace("/", "-")
            calls.append(trading_date)
            payload = {
                "stat": "ok",
                "date": trading_date.replace("-", ""),
                "tables": [{
                    "fields": ["Code", "Name", "Close", "Change", "Open", "High", "Low", "Avg Price", "Trading Shares"],
                    "data": [
                        ["5289", "宜鼎", "1415.00", "+30.00", "1370.00", "1420.00", "1340.00", "1381.81", "3,323,096"],
                        ["6488", "環球晶", "480.00", "+5.00", "475.00", "485.00", "470.00", "479.00", "120,000"],
                    ],
                }],
            }
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), 200, "application/json"

        instruments = [
            {"instrument_id": "TWSE:2308", "market": "TWSE", "symbol": "2308", "display_name": "台達電"},
            {"instrument_id": "TPEx:5289", "market": "TPEx", "symbol": "5289", "display_name": "宜鼎"},
            {"instrument_id": "TPEx:6488", "market": "TPEx", "symbol": "6488", "display_name": "環球晶"},
        ]

        def mixed_fetcher(request: Request) -> tuple[bytes, int, str]:
            if "dailyQuotes" in request.full_url:
                return fake_fetcher(request)
            query = parse_qs(urlsplit(request.full_url).query)
            month = query["date"][0]
            year = int(month[:4])
            month_number = int(month[4:6])
            roc_year = year - 1911
            payload = {
                "stat": "OK",
                "fields": ["日期", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數"],
                "data": [[f"{roc_year:03d}/{month_number:02d}/01", "1,000", "10,000", "10", "11", "9", "10.5", "0.5", "10"]],
            }
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), 200, "application/json"

        with tempfile.TemporaryDirectory(prefix="tqr-data-update-") as directory:
            result = update_twse_watchlist(directory, instruments, 1, today=date(2026, 7, 20), fetcher=mixed_fetcher)
            self.assertEqual(result["scope"], "watchlist")
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["requested_count"], 3)
            self.assertEqual(result["updated_count"], 3)
            self.assertEqual([item["status"] for item in result["results"]], ["success", "success", "success"])
            tpex_sessions = len([item for item in calls if item.startswith("202")])
            self.assertGreater(tpex_sessions, 200)
            self.assertEqual(tpex_sessions, len(set(calls)))
            self.assertEqual(result["results"][1]["bars_downloaded"], tpex_sessions)
            self.assertEqual(result["results"][2]["bars_downloaded"], tpex_sessions)

    def test_watchlist_update_passes_covered_data_and_downloads_only_new_stock(self) -> None:
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

        existing = {"instrument_id": "TWSE:2308", "market": "TWSE", "symbol": "2308", "display_name": "台達電"}
        new_stock = {"instrument_id": "TWSE:1514", "market": "TWSE", "symbol": "1514", "display_name": "亞力"}
        with tempfile.TemporaryDirectory(prefix="tqr-data-update-") as directory:
            first = update_twse_watchlist(directory, [existing], 1, today=date(2026, 7, 20), fetcher=fake_fetcher)
            self.assertEqual(first["status"], "success")
            calls.clear()
            second = update_twse_watchlist(directory, [existing, new_stock], 1, today=date(2026, 7, 20), fetcher=fake_fetcher)
            self.assertEqual(second["status"], "success")
            self.assertEqual(second["requested_count"], 2)
            self.assertEqual(second["updated_count"], 1)
            self.assertEqual(second["passed_count"], 1)
            self.assertEqual([item["status"] for item in second["results"]], ["pass", "success"])
            self.assertTrue(all(call.startswith("1514:") for call in calls))
            self.assertEqual(len(calls), 13)


if __name__ == "__main__":
    unittest.main()
