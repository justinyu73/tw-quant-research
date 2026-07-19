import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.formulas import daily_return_1d, revenue_mom, revenue_yoy  # noqa: E402
from tw_quant_engine.ingestion import map_source_item  # noqa: E402
from tw_quant_engine.product_alignment import build_product_rows, product_digest  # noqa: E402


SYNTHETIC_PATH = ROOT / "tests/fixtures/s4/synthetic-mapping.json"
S3_PATH = ROOT / "tests/fixtures/s3/source-admission.json"


class ProductAlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.synthetic_payload = json.loads(SYNTHETIC_PATH.read_text(encoding="utf-8"))
        cls.s3_payload = json.loads(S3_PATH.read_text(encoding="utf-8"))

    def test_price_and_revenue_formulas_have_exact_expected_values(self) -> None:
        results = [map_source_item(item) for item in self.synthetic_payload["items"]]
        rows = build_product_rows(results)
        price_rows = [row for row in rows if row["record_type"] == "price_bar"]
        self.assertIsNone(price_rows[0]["bar"]["daily_return_1d"])
        self.assertAlmostEqual(price_rows[1]["bar"]["daily_return_1d"], 0.1)

        june = next(
            row
            for row in rows
            if row["record_type"] == "fundamental_observation"
            and row["fundamental"]["period_end"] == "2026-06-30"
        )
        self.assertAlmostEqual(june["fundamental"]["revenue_mom"], 0.25)
        self.assertAlmostEqual(june["fundamental"]["revenue_yoy"], 0.5)

    def test_formula_guards_fail_closed(self) -> None:
        self.assertEqual(daily_return_1d(10, 0, both_admitted=True).reason, "missing_or_zero_prior_close")
        self.assertEqual(daily_return_1d(10, 5, both_admitted=False).reason, "unadmitted_input")
        self.assertEqual(revenue_mom(10, 0).reason, "missing_or_zero_previous_revenue")
        self.assertEqual(revenue_yoy(10, None).reason, "missing_or_invalid_revenue")

    def test_provenance_and_formula_version_survive_alignment(self) -> None:
        results = [map_source_item(item) for item in self.synthetic_payload["items"]]
        rows = build_product_rows(results)
        for row in rows:
            self.assertEqual(row["formula_version"], "s4-v1")
            self.assertTrue(row["provenance"]["endpoint"])
            self.assertRegex(row["provenance"]["content_digest"], r"^sha256:[0-9a-f]{64}$")

    def test_live_unadmitted_rows_have_no_derived_formula(self) -> None:
        results = [map_source_item(item) for item in self.s3_payload["fetches"]]
        rows = build_product_rows(results)
        self.assertTrue(all(row["quality"]["admission_status"] == "unadmitted" for row in rows))
        for row in rows:
            if row["record_type"] == "price_bar":
                self.assertIsNone(row["bar"]["daily_return_1d"])
            if row["record_type"] == "fundamental_observation":
                self.assertIsNone(row["fundamental"]["revenue_mom"])
                self.assertIsNone(row["fundamental"]["revenue_yoy"])

    def test_product_digest_is_deterministic(self) -> None:
        results = [map_source_item(item) for item in self.synthetic_payload["items"]]
        first = build_product_rows(results)
        second = build_product_rows(results)
        self.assertEqual(product_digest(first), product_digest(second))


if __name__ == "__main__":
    unittest.main()
