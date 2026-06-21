import { classifySdsReview, findExtractionConflicts } from "./review-classification.ts";
import { emptyExtraction } from "./schema.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function completeMetadata() {
  return {
    ...emptyExtraction(),
    is_likely_sds: true,
    product_name: "Example Cleaner",
    manufacturer: "Example Industries",
    language: "English",
    revision_date: "2025-01-02",
    signal_word: "WARNING",
    recommended_use: "Industrial cleaning",
    extraction_confidence: 92,
    missing_fields: []
  };
}

Deno.test("clear complete SDS skips AI and receives a pre-screen pass", () => {
  const result = classifySdsReview(completeMetadata(), { sectionsFound: [...Array(16)].map((_, index) => index + 1) });
  assertEquals(result.decision, "auto_prescreen_pass", "decision");
  assertEquals(result.aiShouldVerify, false, "AI routing");
});

Deno.test("high-consequence hazard requires full review", () => {
  const metadata = completeMetadata();
  metadata.hazard_statements = ["H314 Causes severe skin burns and eye damage"];
  const result = classifySdsReview(metadata, { sectionsFound: [...Array(16)].map((_, index) => index + 1) });
  assertEquals(result.riskLevel, "high", "risk level");
  assertEquals(result.decision, "full_review_required", "decision");
});

Deno.test("high-risk keyword is read only from Section 2 evidence", () => {
  const metadata = completeMetadata();
  const result = classifySdsReview(metadata, {
    fullText: "SECTION 1: Identification\nExample Cleaner\nSECTION 2: Hazard Identification\nHighly flammable liquid and vapour\nSECTION 3: Composition",
    sectionsFound: [...Array(16)].map((_, index) => index + 1)
  });
  assertEquals(result.riskLevel, "high", "risk level");
  assertEquals(result.decision, "full_review_required", "decision");
});

Deno.test("missing critical section requires full review", () => {
  const result = classifySdsReview(completeMetadata(), { missingSections: [8] });
  assertEquals(result.decision, "full_review_required", "decision");
});

Deno.test("missing hazard section has unknown risk", () => {
  const result = classifySdsReview(completeMetadata(), { missingSections: [2] });
  assertEquals(result.riskLevel, "unknown", "risk level");
  assertEquals(result.decision, "full_review_required", "decision");
});

Deno.test("weak native text routes to OCR review", () => {
  const result = classifySdsReview(completeMetadata(), { ocrRequired: true });
  assertEquals(result.decision, "ocr_review_required", "decision");
  assertEquals(result.aiShouldVerify, true, "AI routing");
});

Deno.test("exact approved unchanged duplicate avoids a second metadata review", () => {
  const result = classifySdsReview(completeMetadata(), { duplicate: true, existingApprovedUnchanged: true });
  assertEquals(result.decision, "no_review_required_existing_unchanged", "decision");
  assertEquals(result.aiShouldVerify, false, "AI routing");
});

Deno.test("rule and AI disagreement is preserved as a conflict", () => {
  const rule = completeMetadata();
  const ai = { ...completeMetadata(), product_name: "Different Product" };
  const conflicts = findExtractionConflicts(rule, ai);
  if (!conflicts.some((item) => item.includes("product name"))) throw new Error("product-name conflict was not detected");
});
