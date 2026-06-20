import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assessSdsText, extractFirstTwoPages, extractWithRegex, mergeExtraction } from "../src/extraction.js";
import { generateApprovedFilename, normalizeRevisionForFilename, sanitizeFilenamePart } from "../src/filename.js";

const sampleText = `
SAFETY DATA SHEET
Section 1: Identification
Product name: VORATRON ER 201 Epoxy Resin
Trade Name: VORATRON ER 201
Manufacturer: DOW CHEMICAL (MALAYSIA) SDN. BHD.
Supplier: Example Supplier Sdn. Bhd.
Recommended use: Composite applications
Revision date: 22 June 2018
Emergency Contact: 1-800-000-000
Section 2: Hazard Identification
GHS Classification
DANGER
H315 Causes skin irritation.
P280 Wear protective gloves.
CAS No: 25068-38-6
`;

test("regex extraction prioritizes labelled Section 1 fields", () => {
  const result = extractWithRegex(sampleText);
  assert.equal(result.is_likely_sds, true);
  assert.equal(result.product_name, "VORATRON ER 201 Epoxy Resin");
  assert.equal(result.trade_name, "VORATRON ER 201");
  assert.equal(result.manufacturer, "DOW CHEMICAL (MALAYSIA) SDN. BHD");
  assert.equal(result.supplier, "Example Supplier Sdn. Bhd");
  assert.deepEqual(result.cas_numbers, ["25068-38-6"]);
  assert.equal(result.signal_word, "DANGER");
});

test("weak non-SDS text is not accepted as an SDS", () => {
  const assessment = assessSdsText("invoice for ordinary office supplies");
  assert.equal(assessment.weakText, true);
  assert.equal(assessment.isLikelySds, false);
});

test("controlled filename follows the approved metadata rule", () => {
  const filename = generateApprovedFilename({
    product_name: "Cleaner: Heavy/Grade?",
    supplier: "Supplier “Malaysia” <HQ>",
    revision_date: "2026-06-20",
    language: "English"
  });
  assert.equal(filename, "SDS_Cleaner_Heavy_Grade_Supplier_Malaysia_HQ_2026-06-20_EN.pdf");
});

test("unknown revision uses the mandated fallback", () => {
  const filename = generateApprovedFilename({ product_name: "Product A", supplier: "Supplier B", language: "Malay" });
  assert.equal(filename, "SDS_Product_A_Supplier_B_Rev-Date-Unknown_MS.pdf");
});

test("normalizes an unambiguous written revision date for the approved filename", () => {
  assert.equal(normalizeRevisionForFilename("June. 26, 2023"), "2023-06-26");
  assert.equal(normalizeRevisionForFilename("26 June 2023"), "2023-06-26");
});

test("filename sanitizer removes control and illegal characters", () => {
  assert.equal(sanitizeFilenamePart("A:B/C\\D*E?F\nG\tH", "fallback"), "A_B_C_D_E_F_G_H");
});

test("merged extraction always records EHS review reasons", () => {
  const regex = extractWithRegex(sampleText);
  const merged = mergeExtraction(regex, null, { ocrRequired: false, duplicate: true });
  assert.equal(merged.possible_duplicate_flag, true);
  assert.match(merged.review_required_reason, /Possible duplicate detected/);
  assert.match(merged.review_required_reason, /EHS approval is required/);
});

test("extracts the trade name from inside a real SDS PDF", async () => {
  const bytes = await readFile(new URL("../../pdfs/wd-40-aerosol-asia-2023-06-26.pdf", import.meta.url));
  const extracted = await extractFirstTwoPages(new Uint8Array(bytes));
  const result = extractWithRegex(extracted.text);

  assert.equal(extracted.pagesExtracted, 2);
  assert.match(extracted.text, /Trade Name:\s*WD-40 Aerosol/i);
  assert.equal(result.trade_name, "WD-40 Aerosol");
  assert.match(result.first_aid_summary, /DO NOT induce vomiting/i);
  assert.match(result.storage_summary, /Store in a cool, well-ventilated area/i);
});
