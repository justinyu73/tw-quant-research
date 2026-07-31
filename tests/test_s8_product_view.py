import copy
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.product_view import build_read_only_view, read_only_request, view_digest  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/s8/product-view.json"
AS_OF = "2026-01-07T23:59:59Z"


class S8ProductViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def build(self, *, products=None) -> dict:
        return build_read_only_view(
            self.payload["product_rows"] if products is None else products,
            as_of=AS_OF,
            evidence_links=self.payload["evidence_links"],
        )

    def test_as_of_filters_future_rows_and_preserves_quality_states(self) -> None:
        view = self.build()
        self.assertEqual(len(view["products"]), 3)
        self.assertNotIn("2026-01-08", {row["bar"]["trading_date"] for row in view["products"] if "bar" in row})
        self.assertEqual(view["quality"]["status_counts"], {"admitted": 1, "unadmitted": 1, "invalid": 1})
        self.assertEqual(view["quality"]["reason_counts"]["source_conflict"], 1)

    def test_existing_numeric_values_and_lineage_are_not_recalculated(self) -> None:
        view = self.build()
        price = next(row for row in view["products"] if row["quality"]["admission_status"] == "admitted")
        self.assertEqual(price["bar"]["daily_return_1d"], 0.1)
        self.assertEqual(price["provenance"]["snapshot_id"], "s8-price-1")
        self.assertIn("s4-v1", view["formula_versions"])
        self.assertEqual(view["evidence_links"], sorted(self.payload["evidence_links"]))

    def test_read_only_routes_fail_closed(self) -> None:
        view = self.build()
        self.assertEqual(read_only_request(view, "GET", "/products")["status"], 200)
        self.assertEqual(read_only_request(view, "POST", "/products"), {"status": 405, "error": "read_only", "allow": ["GET"]})
        self.assertEqual(read_only_request(view, "DELETE", "/evidence")["status"], 405)
        # The retired factor/backtest surfaces must now be unknown routes.
        self.assertEqual(read_only_request(view, "GET", "/backtest"), {"status": 404, "error": "unknown_route"})
        self.assertEqual(read_only_request(view, "GET", "/features"), {"status": 404, "error": "unknown_route"})
        self.assertEqual(read_only_request(view, "GET", "/orders"), {"status": 404, "error": "unknown_route"})

    def test_empty_state_is_deterministic(self) -> None:
        first = build_read_only_view([], as_of=AS_OF)
        second = build_read_only_view([], as_of=AS_OF)
        self.assertTrue(first["empty_state"])
        self.assertEqual(first["quality"]["status_counts"], {"admitted": 0, "unadmitted": 0, "invalid": 0})
        self.assertEqual(view_digest(first), view_digest(second))

    def test_view_is_offline(self) -> None:
        with patch.object(socket, "socket", side_effect=AssertionError("S8 network is forbidden")):
            view = self.build()
        self.assertTrue(view["read_only"])


if __name__ == "__main__":
    unittest.main()
