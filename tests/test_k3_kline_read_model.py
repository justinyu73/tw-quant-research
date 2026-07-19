import copy
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.kline_aggregation import aggregate_dataset  # noqa: E402
from tw_quant_engine.kline_contract import load_fixture  # noqa: E402
from tw_quant_engine.kline_view import KlineReadModelError, build_kline_read_model, read_only_kline_request  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/k1/ohlcv.json"


class K3KlineReadModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE_PATH)

    def build(self, *, period="1D") -> dict:
        aggregation = aggregate_dataset(self.fixture.by_case("valid"), period=period, as_of=self.fixture.as_of)
        return build_kline_read_model(aggregation)

    def test_required_fields_and_read_only_context_are_present(self) -> None:
        model = self.build()
        for field in ("instrument", "period", "as_of", "timezone", "session", "available_at", "ingested_at", "source", "adjustment_policy", "bars", "indicators", "coverage", "quality", "provenance", "snapshot_digest"):
            self.assertIn(field, model)
        self.assertTrue(model["read_only"])
        self.assertEqual(model["source"], "offline-fixture")
        self.assertEqual(model["instrument"]["instrument_id"], "TWSE:2330")

    def test_ma_and_ema_are_deterministic_and_insufficient_windows_are_explicit(self) -> None:
        model = self.build()
        self.assertEqual(model["indicators"]["ma"]["period"], 5)
        self.assertEqual(model["indicators"]["ema"]["period"], 20)
        self.assertTrue(all(item["value"] is None for item in model["indicators"]["ma"]["values"]))
        self.assertIn("insufficient_indicator_window", model["quality"]["reason_codes"])
        self.assertEqual(model["quality"]["status"], "partial")

    def test_coverage_reports_real_history_and_indicator_depth(self) -> None:
        coverage = self.build()["coverage"]
        self.assertEqual(coverage["bar_count"], 3)
        self.assertEqual(coverage["first_trading_date"], "2026-07-13")
        self.assertEqual(coverage["last_trading_date"], "2026-07-15")
        self.assertEqual(coverage["observed_session_count"], 3)
        self.assertIsNone(coverage["expected_session_count"])
        self.assertEqual(coverage["calendar_status"], "not_supplied")
        self.assertEqual(coverage["depth_status"], "insufficient")
        self.assertEqual(coverage["indicator_ready"], {"ma": False, "ema": False, "rsi": False, "macd": False, "kd": False, "atr": False})

    def test_extended_studies_admit_only_after_their_declared_windows(self) -> None:
        dataset = copy.deepcopy(self.fixture.by_case("valid"))
        start = date(2026, 7, 13)
        for index in range(3, 40):
            trading_date = start + timedelta(days=index)
            close = 1125 + index
            dataset["bars"].append({
                "trading_date": trading_date.isoformat(),
                "bar_time": f"{trading_date.isoformat()}T13:30:00+08:00",
                "timezone": "Asia/Taipei",
                "session": "regular",
                "available_at": f"{trading_date.isoformat()}T18:00:00+08:00",
                "open": close - 2,
                "high": close + 10,
                "low": close - 10,
                "close": close,
                "volume": 10000000 + index,
            })
        model = build_kline_read_model(aggregate_dataset(dataset, period="1D", as_of="2026-09-01T23:59:59Z"))
        self.assertEqual(model["coverage"]["depth_status"], "ready")
        self.assertEqual(model["quality"]["status"], "valid")
        self.assertEqual(model["indicators"]["rsi"]["values"][13]["status"], "insufficient_window")
        self.assertEqual(model["indicators"]["rsi"]["values"][14]["status"], "admitted")
        self.assertEqual(model["indicators"]["atr"]["values"][13]["status"], "admitted")
        self.assertEqual(model["indicators"]["kd"]["values"][8]["status"], "admitted")
        self.assertEqual(model["indicators"]["macd"]["signal_values"][33]["status"], "admitted")

    def test_empty_and_unsupported_states_remain_distinct(self) -> None:
        empty_aggregation = aggregate_dataset(self.fixture.by_case("empty"), period="1D", as_of=self.fixture.as_of)
        unsupported_aggregation = aggregate_dataset(self.fixture.by_case("unsupported"), period="M", as_of=self.fixture.as_of)
        empty = build_kline_read_model(empty_aggregation)
        unsupported = build_kline_read_model(unsupported_aggregation)
        self.assertEqual(empty["quality"]["status"], "unavailable")
        self.assertEqual(unsupported["quality"]["status"], "unsupported_period")
        self.assertEqual(empty["bars"], [])
        self.assertEqual(unsupported["bars"], [])

    def test_read_only_routes_fail_closed(self) -> None:
        model = self.build()
        self.assertEqual(read_only_kline_request(model, "GET", "/kline")["status"], 200)
        self.assertEqual(read_only_kline_request(model, "GET", "/kline/bars")["status"], 200)
        self.assertEqual(read_only_kline_request(model, "POST", "/kline"), {"status": 405, "error": "read_only", "allow": ["GET"]})
        self.assertEqual(read_only_kline_request(model, "GET", "/orders"), {"status": 404, "error": "unknown_route"})

    def test_future_bar_is_rejected_by_view_model(self) -> None:
        aggregation = aggregate_dataset(self.fixture.by_case("valid"), period="1D", as_of=self.fixture.as_of)
        future = copy.deepcopy(aggregation["bars"][0])
        future["available_at"] = "2026-07-16T18:00:00Z"
        aggregation["bars"].append(future)
        with self.assertRaisesRegex(KlineReadModelError, "after as_of"):
            build_kline_read_model(aggregation)

    def test_snapshot_digest_is_stable(self) -> None:
        self.assertEqual(self.build()["snapshot_digest"], self.build()["snapshot_digest"])


if __name__ == "__main__":
    unittest.main()
