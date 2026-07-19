import copy
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.kline_contract import KlineContractError, KlineFixture, load_fixture  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/k1/ohlcv.json"


class K1KlineContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.fixture = load_fixture(FIXTURE_PATH)

    def test_fixture_digest_is_stable(self) -> None:
        self.assertEqual(
            self.fixture.digest(),
            "sha256:a81052c077713b0e7e8f50fa68162d323e5056136f5b85d477cc05974df377b6",
        )

    def test_fixture_is_offline_and_covers_required_markets_and_cases(self) -> None:
        self.assertEqual(self.fixture.payload["provenance"]["source"], "offline-fixture")
        self.assertFalse(self.fixture.payload["provenance"]["network"])
        self.assertFalse(self.fixture.payload["provenance"]["provider_calls"])
        self.assertEqual({dataset["case"] for dataset in self.fixture.datasets}, {"valid", "partial", "empty", "unsupported"})
        self.assertEqual({dataset["instrument"]["market"] for dataset in self.fixture.datasets}, {"TWSE", "US", "TAIFEX"})

    def test_instrument_identity_and_futures_contract_are_explicit(self) -> None:
        self.assertEqual(self.fixture.by_case("valid")["instrument"]["instrument_id"], "TWSE:2330")
        futures = self.fixture.by_case("unsupported")["instrument"]
        self.assertEqual(futures["instrument_id"], "TAIFEX:TX:202609")
        self.assertEqual(futures["contract_month"], "202609")
        self.assertEqual(futures["expiry"], "2026-09-16")

    def test_ohlcv_invariants_and_timestamps_are_explicit(self) -> None:
        for dataset in self.fixture.datasets:
            for bar in dataset["bars"]:
                self.assertLessEqual(max(bar["open"], bar["close"]), bar["high"])
                self.assertGreaterEqual(min(bar["open"], bar["close"]), bar["low"])
                self.assertGreaterEqual(bar["volume"], 0)
                self.assertIn("T", bar["bar_time"])
                self.assertTrue(bar["timezone"])
                self.assertTrue(bar["session"])
                self.assertTrue(bar["available_at"].endswith("Z"))

    def test_quality_cases_fail_closed(self) -> None:
        self.assertEqual(self.fixture.by_case("valid")["quality"], {"status": "valid", "reason_codes": []})
        self.assertEqual(self.fixture.by_case("partial")["quality"]["status"], "partial")
        self.assertEqual(self.fixture.by_case("empty")["quality"], {"status": "unavailable", "reason_codes": ["no_data"]})
        unsupported = self.fixture.by_case("unsupported")
        self.assertEqual(unsupported["unsupported_periods"], ["M", "Q"])
        self.assertEqual(unsupported["periods_available"], ["1D", "1W"])

    def test_fixture_has_no_future_available_at_values(self) -> None:
        self.assertTrue(
            all(
                bar["available_at"] <= self.fixture.as_of
                for dataset in self.fixture.datasets
                for bar in dataset["bars"]
            )
        )

    def test_loading_does_not_open_network(self) -> None:
        with patch.object(socket, "socket", side_effect=AssertionError("K1 network is forbidden")):
            loaded = load_fixture(FIXTURE_PATH)
        self.assertEqual(loaded.digest(), self.fixture.digest())

    def test_naive_bar_timestamp_is_rejected(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["datasets"][0]["bars"][0]["available_at"] = "2026-07-13T18:00:00"
        with self.assertRaisesRegex(KlineContractError, "explicit timezone"):
            KlineFixture.from_payload(payload)

    def test_invalid_ohlcv_is_rejected(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["datasets"][0]["bars"][0]["low"] = 1106
        with self.assertRaisesRegex(KlineContractError, "low is above open/close"):
            KlineFixture.from_payload(payload)

    def test_duplicate_canonical_instrument_is_rejected(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["datasets"][1]["instrument"] = copy.deepcopy(payload["datasets"][0]["instrument"])
        with self.assertRaisesRegex(KlineContractError, "duplicate canonical instrument_id"):
            KlineFixture.from_payload(payload)

    def test_empty_case_cannot_silently_contain_bars(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["datasets"][2]["bars"] = [copy.deepcopy(payload["datasets"][0]["bars"][0])]
        with self.assertRaisesRegex(KlineContractError, "empty requires unavailable no_data state"):
            KlineFixture.from_payload(payload)


if __name__ == "__main__":
    unittest.main()
