import { assessSdsText, detectSdsDates, detectSections, extractWithRegex } from "./extraction.ts";

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

Deno.test("detects English and Bahasa SDS dates with validity priority", () => {
  const dates = detectSdsDates(`
Revision date: 25-JUN-2021
Issue date: June 20, 2021
Tarikh cetakan: 06/25/2021
`);
  equal(dates.revision_date, "2021-06-25", "revision date");
  equal(dates.issue_date, "2021-06-20", "issue date");
  equal(dates.print_date, "2021-06-25", "print date");
  equal(dates.validity_date_basis, "revision_date", "validity basis");
  equal(dates.detected_date_source, "Revision date", "source label");
});

Deno.test("uses print date only as low-confidence last resort", () => {
  const dates = detectSdsDates("Printed date: 25.06.2021");
  equal(dates.validity_date_basis, "print_date", "print basis");
  equal(dates.detected_date_confidence, 35, "print confidence");
  if (!dates.date_detection_warnings.some((warning) => warning.includes("Print date"))) throw new Error("missing print-date warning");
});

Deno.test("flags conflicting SDS dates", () => {
  const dates = detectSdsDates("Date of revision: 2021-06-25\nDate of issue: 2020-01-10");
  if (!dates.date_detection_warnings.some((warning) => warning.includes("Multiple SDS dates"))) throw new Error("missing conflict warning");
});

Deno.test("detects numbered English and Bahasa section headings", () => {
  const headings = [
    "SECTION 1: Identification", "SECTION 2: Hazard identification", "SECTION 3: Composition / information on ingredients",
    "SECTION 4: First aid measures", "SECTION 5: Fire fighting measures", "SECTION 6: Accidental release measures",
    "SECTION 7: Handling and storage", "SECTION 8: Exposure controls / personal protection",
    "SECTION 9: Physical and chemical properties", "SECTION 10: Stability and reactivity",
    "SECTION 11: Toxicological information", "SECTION 12: Ecological information", "SECTION 13: Disposal considerations",
    "SECTION 14: Transport information", "SECTION 15: Regulatory information", "SECTION 16: Maklumat lain"
  ].join("\n");
  const sections = detectSections(headings);
  equal(sections.found, Array.from({ length:16 }, (_, index) => index + 1), "sections found");
  equal(sections.confidence, 100, "section confidence");
});

Deno.test("extracts the labelled WD-40 trade name without relying on the filename", () => {
  const metadata = extractWithRegex("SAFETY DATA SHEET\nSection 1: Identification\nTrade Name: WD-40 Aerosol\nSection 2: Hazard Identification\nGHS\nSupplier: WD-40 Company\nEmergency Contact: 123");
  if (!String(metadata.trade_name || metadata.product_name).toLowerCase().includes("wd-40 aerosol")) {
    throw new Error(`wrong WD-40 identity: ${metadata.product_name} / ${metadata.trade_name}`);
  }
});

Deno.test("routes an image-only SDS to Gemini/OCR", () => {
  const assessment = assessSdsText("");
  equal(assessment.weakText, true, "OCR routing");
});
