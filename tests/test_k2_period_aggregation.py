import copy
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.kline_aggregation import KlineAggregationError, aggregate_dataset, aggregate_digest  # noqa: E402
from tw_quant_engine.kline_contract import load_fixture  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/k1/ohlcv.json"


class K2PeriodAggregationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE_PATH)
        cls.twse = cls.fixture.by_case("valid")

    def test_one_day_aggregation_preserves_ohlcv(self) -> None:
        result = aggregate_dataset(self.twse, period="1D", as_of=self.fixture.as_of)
        self.assertEqual(result["quality"]["status"], "valid")
        self.assertEqual(len(result["bars"]), 3)
        self.assertEqual(result["bars"][0]["open"], 1080)
        self.assertEqual(result["bars"][0]["high"], 1110)
        self.assertEqual(result["bars"][0]["low"], 1075)
        self.assertEqual(result["bars"][0]["close"], 1105)
        self.assertEqual(result["bars"][0]["volume"], 12000000)

    def test_week_month_quarter_require_explicit_complete_calendar(self) -> None:
        for period in ("1W", "M", "Q"):
            result = aggregate_dataset(self.twse, period=period, as_of=self.fixture.as_of)
            self.assertEqual(result["quality"]["status"], "partial")
            self.assertIn("calendar_not_supplied", result["quality"]["reason_codes"])

    def test_complete_week_uses_expected_sessions_and_ohlcv_rules(self) -> None:
        dataset = copy.deepcopy(self.twse)
        extra = [
            ("2026-07-16", 1126, 1140, 1120, 1135, 14000000),
            ("2026-07-17", 1138, 1150, 1130, 1145, 15000000),
        ]
        for trading_date, open_value, high, low, close, volume in extra:
            dataset["bars"].append({
                "trading_date": trading_date,
                "bar_time": f"{trading_date}T13:30:00+08:00",
                "timezone": "Asia/Taipei",
                "session": "regular",
                "available_at": f"{trading_date}T18:00:00+08:00",
                "open": open_value,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            })
        expected = {"2026-W29": [f"2026-07-{day:02d}" for day in range(13, 18)]}
        result = aggregate_dataset(dataset, period="1W", as_of="2026-07-17T23:59:59Z", expected_sessions=expected)
        self.assertEqual(result["quality"]["status"], "valid")
        bar = result["bars"][0]
        self.assertEqual(bar["period_key"], "2026-W29")
        self.assertEqual(bar["open"], 1080)
        self.assertEqual(bar["high"], 1150)
        self.assertEqual(bar["low"], 1075)
        self.assertEqual(bar["close"], 1145)
        self.assertEqual(bar["volume"], 12000000 + 9800000 + 13500000 + 14000000 + 15000000)
        self.assertEqual(bar["quality"]["status"], "valid")
        self.assertEqual(bar["quality"]["missing_sessions"], [])

    def test_month_and_quarter_complete_calendar_are_accepted(self) -> None:
        dataset = copy.deepcopy(self.twse)
        expected_month = {"2026-07": ["2026-07-13", "2026-07-14", "2026-07-15"]}
        expected_quarter = {"2026-Q3": ["2026-07-13", "2026-07-14", "2026-07-15"]}
        month = aggregate_dataset(dataset, period="M", as_of=self.fixture.as_of, expected_sessions=expected_month)
        quarter = aggregate_dataset(dataset, period="Q", as_of=self.fixture.as_of, expected_sessions=expected_quarter)
        self.assertEqual(month["quality"]["status"], "valid")
        self.assertEqual(quarter["quality"]["status"], "valid")
        self.assertEqual(month["bars"][0]["period_start"], "2026-07-01")
        self.assertEqual(quarter["bars"][0]["period_start"], "2026-07-01")

    def test_missing_expected_session_is_partial_not_filled(self) -> None:
        expected = {"2026-W29": ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"]}
        result = aggregate_dataset(self.twse, period="1W", as_of=self.fixture.as_of, expected_sessions=expected)
        self.assertEqual(result["quality"]["status"], "partial")
        self.assertIn("missing_sessions", result["quality"]["reason_codes"])
        self.assertEqual(result["quality"]["missing_sessions"], ["2026-07-16", "2026-07-17"])

    def test_as_of_hides_post_cutoff_bar(self) -> None:
        dataset = copy.deepcopy(self.twse)
        future = copy.deepcopy(dataset["bars"][-1])
        future["trading_date"] = "2026-07-16"
        future["bar_time"] = "2026-07-16T13:30:00+08:00"
        future["available_at"] = "2026-07-17T18:00:00+08:00"
        dataset["bars"].append(future)
        result = aggregate_dataset(dataset, period="1D", as_of=self.fixture.as_of)
        self.assertEqual([bar["trading_date"] for bar in result["bars"]], ["2026-07-13", "2026-07-14", "2026-07-15"])

    def test_empty_and_unsupported_states_are_explicit(self) -> None:
        empty = aggregate_dataset(self.fixture.by_case("empty"), period="1D", as_of=self.fixture.as_of)
        unsupported = aggregate_dataset(self.fixture.by_case("unsupported"), period="M", as_of=self.fixture.as_of)
        self.assertEqual(empty["quality"]["status"], "unavailable")
        self.assertEqual(unsupported["quality"]["status"], "unsupported_period")
        self.assertEqual(unsupported["bars"], [])

    def test_digest_is_stable(self) -> None:
        first = aggregate_dataset(self.twse, period="1D", as_of=self.fixture.as_of)
        second = aggregate_dataset(self.twse, period="1D", as_of=self.fixture.as_of)
        self.assertEqual(aggregate_digest(first), aggregate_digest(second))
        self.assertEqual(aggregate_digest(first), "sha256:d58aac90254cb6a6406ba33db48dc997daa0a9e1e64e9adb2bf69d0e13edf1ad")

    def test_invalid_expected_calendar_fails_closed(self) -> None:
        with self.assertRaisesRegex(KlineAggregationError, "duplicate dates"):
            aggregate_dataset(self.twse, period="1W", as_of=self.fixture.as_of, expected_sessions={"2026-W29": ["2026-07-13", "2026-07-13"]})


if __name__ == "__main__":
    unittest.main()
