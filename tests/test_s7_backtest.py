import copy
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.backtest import (  # noqa: E402
    BacktestConfig,
    BacktestError,
    backtest_digest,
    run_backtest,
)


FIXTURE_PATH = ROOT / "tests/fixtures/s7/backtest.json"


class S7BacktestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def run_fixture(self, *, signals=None, config=None) -> dict:
        return run_backtest(
            self.payload["records"],
            self.payload["provenance"],
            self.payload["signals"] if signals is None else signals,
            as_of=self.payload["as_of"],
            config=BacktestConfig(**(self.payload["config"] if config is None else config)),
        )

    def test_signal_executes_at_next_bar_open(self) -> None:
        result = self.run_fixture()
        self.assertEqual(result["schema"], "tw-quant-engine-backtest-result/v1")
        self.assertEqual(result["metrics"]["trade_count"], 2)
        self.assertEqual(result["trades"][0]["signal_date"], "2026-01-02")
        self.assertEqual(result["trades"][0]["execution_date"], "2026-01-05")
        self.assertEqual(result["trades"][0]["execution_price"], 100.0)
        self.assertEqual(result["trades"][1]["execution_date"], "2026-01-06")
        self.assertAlmostEqual(result["equity_curve"][-1]["equity"], 1200.0)
        self.assertAlmostEqual(result["metrics"]["cumulative_return"], 0.2)

    def test_cost_and_slippage_are_visible_and_reduce_result(self) -> None:
        result = self.run_fixture(config={"initial_cash": 1000, "transaction_cost_bps": 25, "slippage_bps": 50, "calendar_days_per_year": 365})
        self.assertLess(result["equity_curve"][-1]["equity"], 1200.0)
        self.assertEqual(result["trades"][0]["transaction_cost_bps"], 25)
        self.assertEqual(result["trades"][0]["slippage_bps"], 50)
        self.assertGreater(result["trades"][0]["fee"], 0.0)

    def test_unadmitted_signal_cannot_trade(self) -> None:
        signals = copy.deepcopy(self.payload["signals"])
        signals[0]["status"] = "draft"
        with self.assertRaisesRegex(BacktestError, "unadmitted"):
            self.run_fixture(signals=signals)

    def test_final_bar_signal_is_rejected(self) -> None:
        signals = copy.deepcopy(self.payload["signals"])
        signals.append({"signal_date":"2026-01-07","target_position":1,"available_at":"2026-01-07T14:30:00+08:00","status":"admitted","snapshot_id":"s7-signal-final"})
        with self.assertRaisesRegex(BacktestError, "final bar"):
            self.run_fixture(signals=signals)

    def test_as_of_hides_signal_after_cutoff(self) -> None:
        signals = copy.deepcopy(self.payload["signals"])
        signals.append({"signal_date":"2026-01-06","target_position":1,"available_at":"2026-01-08T14:30:00+08:00","status":"admitted","snapshot_id":"s7-signal-future"})
        result = self.run_fixture(signals=signals)
        self.assertEqual(result["metrics"]["trade_count"], 2)

    def test_digest_is_deterministic(self) -> None:
        first = self.run_fixture()
        second = self.run_fixture()
        self.assertEqual(backtest_digest(first), backtest_digest(second))

    def test_backtest_is_offline(self) -> None:
        with patch.object(socket, "socket", side_effect=AssertionError("S7 network is forbidden")):
            result = self.run_fixture()
        self.assertEqual(result["metrics"]["trade_count"], 2)


if __name__ == "__main__":
    unittest.main()
