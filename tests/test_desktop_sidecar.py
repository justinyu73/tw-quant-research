import json
import sys
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.desktop_sidecar import (  # noqa: E402
    SIDECAR_INSTRUMENTS_SCHEMA,
    SIDECAR_KLINE_SCHEMA,
    SidecarContractError,
    create_server,
    load_catalog,
    validate_loopback_host,
)


class DesktopSidecarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_catalog(ROOT / "tests" / "fixtures")
        cls.server = create_server(cls.catalog, port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def _get(self, path: str) -> tuple[int, dict[str, object]]:
        with urlopen(f"{self.base}{path}", timeout=5) as response:  # nosec B310 - test server is loopback-only
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_loopback_bind_rejects_public_addresses(self) -> None:
        self.assertEqual(validate_loopback_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(validate_loopback_host("localhost"), "localhost")
        with self.assertRaises(SidecarContractError):
            validate_loopback_host("0.0.0.0")

    def test_instruments_are_offline_and_digest_is_stable(self) -> None:
        status, payload = self._get("/instruments")
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema"], SIDECAR_INSTRUMENTS_SCHEMA)
        self.assertTrue(payload["read_only"])
        ids = {item["instrument_id"] for item in payload["instruments"]}
        self.assertIn("TWSE:2330", ids)
        self.assertIn("TAIFEX:TX:202608", ids)
        self.assertEqual(self.catalog.digest, payload["digest"])
        self.assertEqual(self.catalog.digest, load_catalog(ROOT / "tests" / "fixtures").digest)
        for model in self.catalog.models.values():
            self.assertEqual(model["source"], "offline-fixture")

    def test_kline_get_builds_real_read_model_with_stable_digest(self) -> None:
        path = f"/kline?instrument={quote('TWSE:2330')}&period=1D"
        status, payload = self._get(path)
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema"], SIDECAR_KLINE_SCHEMA)
        model = payload["data"]
        self.assertEqual(model["instrument"]["instrument_id"], "TWSE:2330")
        self.assertIn("k6a-twse_daily_close-2026-07-15", model["provenance"]["fixture_id"])
        self.assertIn("k6a-twse_stock_day-2026-06-30", model["provenance"]["fixture_id"])
        self.assertTrue(model["bars"])
        self.assertGreaterEqual(len(model["bars"]), 350)
        self.assertIsNotNone(model["indicators"]["ema"]["values"][-1]["value"])
        self.assertIsNotNone(model["indicators"]["macd"]["values"][-1]["value"])
        self.assertEqual(payload["digest"], model["snapshot_digest"])
        self.assertEqual(model["snapshot_digest"], self.catalog.models[("TWSE:2330", "1D")]["snapshot_digest"])

    def test_only_get_routes_are_served(self) -> None:
        request = Request(f"{self.base}/kline", method="POST")
        with self.assertRaises(HTTPError) as context:
            urlopen(request, timeout=5)  # nosec B310 - test server is loopback-only
        self.assertEqual(context.exception.code, 405)
        with self.assertRaises(HTTPError) as context:
            urlopen(f"{self.base}/orders", timeout=5)  # nosec B310 - test server is loopback-only
        self.assertEqual(context.exception.code, 404)

    def test_kline_query_requires_both_explicit_parameters(self) -> None:
        with self.assertRaises(HTTPError) as context:
            urlopen(f"{self.base}/kline?instrument=TWSE%3A2330", timeout=5)  # nosec B310 - loopback
        self.assertEqual(context.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
