from __future__ import annotations

import argparse
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import bulk_prescreen as bp  # noqa: E402


def sample_sds(*, include_section_2: bool = True, include_section_8: bool = True, hazards: str = "") -> str:
    sections = [
        "SAFETY DATA SHEET",
        "SECTION 1: Identification\nProduct name: Example Cleaner\nManufacturer: Example Chemicals Sdn. Bhd.\nRecommended use: Industrial cleaning",
    ]
    if include_section_2:
        sections.append(f"SECTION 2: Hazard Identification\n{hazards or 'No classified hazards'}")
    sections.extend(
        [
            "SECTION 3: Composition / information on ingredients",
            "SECTION 4: First aid measures",
            "SECTION 5: Fire fighting measures",
            "SECTION 6: Accidental release measures",
            "SECTION 7: Handling and storage",
        ]
    )
    if include_section_8:
        sections.append("SECTION 8: Exposure controls / personal protection\nWear suitable gloves")
    sections.extend(
        [
            "SECTION 9: Physical and chemical properties",
            "SECTION 10: Stability and reactivity",
            "SECTION 11: Toxicological information",
            "SECTION 12: Ecological information",
            "SECTION 13: Disposal considerations",
            "SECTION 14: Transport information",
            "SECTION 15: Regulatory information",
            "SECTION 16: Other information\nRevision date: 25 Jun 2021",
        ]
    )
    return "\n".join(sections)


class BulkPrescreenRulesTest(unittest.TestCase):
    def test_text_sds_extracts_labelled_identity_without_ai(self):
        record = bp.analyze_text(sample_sds(), "unhelpful-file-name.pdf")
        self.assertEqual(record["product_name"], "Example Cleaner")
        self.assertEqual(record["manufacturer"], "Example Chemicals Sdn. Bhd")
        self.assertEqual(record["document_type"], "SDS")
        self.assertGreaterEqual(record["confidence_score"], 85)
        self.assertEqual(record["review_decision"], "auto_prescreen_pass")
        self.assertFalse(bp.should_use_ai(record, "selective"))

    def test_missing_section_2_requires_full_review(self):
        record = bp.analyze_text(sample_sds(include_section_2=False), "example.pdf")
        self.assertEqual(record["review_decision"], "full_review_required")
        self.assertTrue(any("Section 2" in reason for reason in record["review_reasons"]))

    def test_missing_section_8_requires_full_review(self):
        record = bp.analyze_text(sample_sds(include_section_8=False), "example.pdf")
        self.assertEqual(record["review_decision"], "full_review_required")
        self.assertTrue(any("Section 8" in reason for reason in record["review_reasons"]))

    def test_high_risk_h_code_requires_full_review(self):
        record = bp.analyze_text(sample_sds(hazards="DANGER H314 Causes severe skin burns and eye damage"), "example.pdf")
        self.assertEqual(record["risk_level"], "high")
        self.assertEqual(record["review_decision"], "full_review_required")

    def test_unchanged_cache_record_skips_ai(self):
        cache = {
            "schemaVersion": 1,
            "scannerVersion": bp.SCANNER_VERSION,
            "resultsBySha256": {"abc": {"confidence_score": 55, "review_decision": "quick_check_required"}},
        }
        record = bp.reusable_cached_record(cache, "abc", False)
        self.assertIsNotNone(record)
        record["cache_reused"] = True
        self.assertFalse(bp.should_use_ai(record, "selective"))

    def test_existing_approved_unchanged_needs_no_review(self):
        record = bp.analyze_text(sample_sds(), "example.pdf")
        record["existing_approved_unchanged"] = True
        record["conflicts"] = []
        decision, reasons = bp.decide_review(record)
        self.assertEqual(decision, "no_review_required_existing_unchanged")
        self.assertTrue(reasons)

    def test_same_hash_with_catalog_metadata_conflict_requires_full_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            pdf_dir = Path(temporary)
            pdf_path = pdf_dir / "example.pdf"
            pdf_path.write_bytes(b"%PDF-test")
            record = bp.analyze_text(sample_sds(), pdf_path.name)
            record.update(file_name=pdf_path.name, sha256=bp.sha256_file(pdf_path), conflicts=[])
            catalog = {
                "documents": [{
                    "id": "example", "file": pdf_path.name, "name": "Different Approved Product",
                    "manufacturer": "Example Chemicals Sdn. Bhd", "revisionDate": "2021-06-25",
                }]
            }
            bp.annotate_catalog_and_duplicates([record], catalog, pdf_dir)
            self.assertFalse(record["existing_approved_unchanged"])
            self.assertEqual(record["review_decision"], "full_review_required")
            self.assertTrue(record["conflicts"])

    def test_ocr_sds_routes_to_ocr_review(self):
        record = bp.analyze_text(sample_sds(), "scan.pdf", ocr_used=True)
        self.assertEqual(record["review_decision"], "ocr_review_required")
        self.assertTrue(bp.should_use_ai(record, "selective"))

    def test_ambiguous_numeric_date_is_flagged(self):
        text = sample_sds().replace("25 Jun 2021", "01/02/2021")
        record = bp.analyze_text(text, "example.pdf")
        self.assertTrue(record["date_ambiguous"])
        self.assertNotEqual(record["review_decision"], "auto_prescreen_pass")

    def test_gemini_quota_error_does_not_raise(self):
        verifier = bp.GeminiVerifier("test-key", "gemini-test", 2)
        http_error = urllib.error.HTTPError("https://example.invalid", 429, "quota", {}, None)
        try:
            with mock.patch("urllib.request.urlopen", side_effect=http_error):
                result = verifier.verify({"file_name": "example.pdf", "evidence_snippets": {}})
        finally:
            http_error.close()
        self.assertEqual(result["status"], "quota_exceeded")
        self.assertFalse(result["used"])
        self.assertTrue(verifier.quota_exhausted)

    def test_ai_conflict_forces_full_review(self):
        record = bp.analyze_text(sample_sds(), "example.pdf")
        bp.apply_ai_verification(
            record,
            {
                "status": "verified",
                "used": True,
                "reason": "",
                "result": {
                    "verification_status": "warning",
                    "conflicts": ["Product name is not supported"],
                    "unsupported_fields": ["product_name"],
                    "recommended_review_decision": "full_review_required",
                },
            },
        )
        self.assertEqual(record["review_decision"], "full_review_required")
        self.assertTrue(record["conflicts"])

    def test_manual_catalog_metadata_is_never_overwritten(self):
        record = bp.analyze_text(sample_sds(), "example.pdf")
        record["existing_catalog_match"] = {"id": "example", "same_hash": True}
        record["confidence_score"] = 100
        catalog = {
            "documents": [
                {
                    "id": "example",
                    "file": "example.pdf",
                    "name": "Manual Name",
                    "manufacturer": "Manual Manufacturer",
                    "revisionDate": "2020-01-01",
                    "productCode": "MANUAL-CODE",
                }
            ]
        }
        self.assertEqual(bp.build_enrichment_proposals([record], catalog), [])

    def test_report_schema_excludes_full_pdf_text(self):
        record = bp.analyze_text(sample_sds(), "example.pdf")
        record.update(file_name="example.pdf", sha256="abc", ai_status="skipped_rule_clear", ai_verification_used=False)
        args = argparse.Namespace(
            ai_mode="selective", ai_max_calls=25, ocr_pages=3, native_pages=40,
            evidence_max_chars=3000, force=False,
        )
        verifier = bp.GeminiVerifier("", "gemini-test", 25)
        reports = bp.build_reports([record], [], args, verifier)
        bp.validate_report(reports["prescreen"])
        self.assertNotIn("extracted_text", reports["prescreen"]["records"][0])

    def test_empty_pdf_folder_still_generates_all_reports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pdf_dir = root / "pdfs"
            output = root / "data"
            pdf_dir.mkdir()
            catalog = root / "catalog.json"
            catalog.write_text('{"schemaVersion":1,"documents":[]}', encoding="utf-8")
            exit_code = bp.main(
                [
                    "--pdf-dir", str(pdf_dir), "--catalog", str(catalog), "--output-dir", str(output),
                    "--cache", str(output / ".cache.json"), "--ai-mode", "off",
                ]
            )
            self.assertEqual(exit_code, 0)
            for filename in bp.DEFAULT_OUTPUTS.values():
                self.assertTrue((output / filename).is_file(), filename)


if __name__ == "__main__":
    unittest.main()
