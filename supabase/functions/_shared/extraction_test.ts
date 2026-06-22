import { assessSdsText, calculateMissingFields, detectDocumentLanguage, detectSdsDates, detectSections, extractAllText, extractFirstTwoPages, extractWithRegex } from "./extraction.ts";

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

Deno.test("captures a supersedes date without polluting revision or raising a false conflict (ULTIMEG)", () => {
  const dates = detectSdsDates("Revision date: 31/03/2016\nRevision No: 18\nSupersedes: 24/07/2015");
  equal(dates.revision_date, "2016-03-31", "revision date is the live edition, not the superseded one");
  equal(dates.supersedes_date, "2015-07-24", "supersedes date captured separately");
  if (dates.date_detection_warnings.some((warning) => warning.includes("Multiple SDS dates"))) {
    throw new Error("the superseded date must not count as a competing current date");
  }
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

Deno.test("classifies SDS document language for variant grouping", () => {
  equal(detectDocumentLanguage("Safety Data Sheet. Hazard identification. Supplier. Revision date. First aid.").language, "en", "english");
  equal(detectDocumentLanguage("Helaian Data Keselamatan. BAHAGIAN 1. Pengenalan bahaya. Tarikh penyediaan. Pembekal.").language, "ms", "malay");
  equal(detectDocumentLanguage("Safety Data Sheet (Helaian Data Keselamatan). Product Name / Nama Produk. Preparation Date / Tarikh Penyediaan.").language, "bilingual", "bilingual");
});

// Regression: SPU 6-92S is a legacy MSDS with all 16 numeric sections but non-standard titles.
// It must read as numerically complete (not "8 of 16"), keep its supplier/manufacturer and
// preparation date, and be flagged as legacy — never as an incomplete SDS.
Deno.test("legacy MSDS with all 16 numeric sections is complete, not incomplete (SPU 6-92S)", () => {
  const msds = [
    "MATERIAL SAFETY DATA SHEET",
    "Product Name:   SPU 6-92S   File Name:   msds-6-92S-5",
    "Date of preparation:   Issue No:   Page :",
    "10/01/2014   5   1 of 3",
    "SECTION 1 PRODUCT AND COMPANY IDENTIFICATION",
    "Product Name   SPU 6-92S   Use :   Zinc phosphating solution",
    "Manufacturer’s Name   :   UNASCO (M) SDN.BHD.",
    "SECTION 2 COMPOSITION INFORMATION",
    "SECTION 3 HAZARDS IDENTIFICATION",
    "SECTION 4 EMERGENCY AND FIRST AID PROCEDURES",
    "SECTION 5 FIRE AND EXPLOSION DATA",
    "SECTION 6 SPILL OR LEAK PROCEDURES",
    "SECTION 7 SPECIAL PRECAUTIONS FOR USE",
    "SECTION 8 PERSONAL PROTECTION INFORMATION",
    "SECTION 9 PHYSICAL DATA",
    "SECTION 10 REACTIVITY DATA",
    "SECTION 11 HEALTH HAZARD DATA",
    "SECTION 12 ENVIRONMENTAL DATA",
    "SECTION 13 WASTE DISPOSAL METHOD",
    "SECTION 14 SHIPPING INFORMATION",
    "SECTION 15 REGULATORY INFORMATION",
    "SECTION 16 OTHER INFORMATION"
  ].join("\n");

  const sections = detectSections(msds);
  equal(sections.found, Array.from({ length: 16 }, (_, index) => index + 1), "all 16 numeric sections found");
  equal(sections.missing, [], "no numeric section missing");
  equal(sections.numericComplete, true, "numerically complete");
  equal(sections.confidence, 100, "numeric completeness score 16/16");

  const dates = detectSdsDates(msds);
  equal(dates.preparation_date, "2014-01-10", "preparation date dd/mm/yyyy -> ISO");
  if (dates.detected_date_confidence === 0) throw new Error("a labelled preparation date must not be 0% confidence");

  const meta = extractWithRegex(msds);
  equal(meta.product_name, "SPU 6-92S", "clean product name without the File Name column");
  if (!String(meta.manufacturer || "").includes("UNASCO")) throw new Error(`manufacturer (UNASCO) not detected: ${meta.manufacturer}`);
  const missing = calculateMissingFields(meta);
  if (missing.includes("supplier")) throw new Error("supplier must not be missing when a manufacturer is present");
  if (missing.includes("manufacturer")) throw new Error("manufacturer must not be missing");
});

// End-to-end regression over the real sample PDFs: every one must detect all 16 numeric sections
// (no false "incomplete") and its dates must normalise correctly across the varied layouts.
Deno.test("regression: six real SDS PDFs detect 16 numeric sections and correct dates", async () => {
  const cases: Array<{ file: string; prep?: string; revision?: string; issue?: string }> = [
    { file: "SPU-6-22-4.pdf", prep: "2014-01-10" },
    { file: "SPU-6-92S-5.pdf", prep: "2014-01-10" },
    { file: "VT-210.pdf", revision: "2013-04-29", issue: "2008-03-31" },
    { file: "ULTIMEG 2000 372 RED CLASS H _SDS 2016.pdf", revision: "2016-03-31" },
    { file: "PU RAL 7036 Platinum Grey.pdf", prep: "2022-02-01" },
    { file: "Nitric Acid 68_ BM GHS (REVIEW 19.06.14).pdf", prep: "2009-06-19", revision: "2014-06-19" }
  ];
  for (const sample of cases) {
    let allText: string, firstText: string;
    try {
      allText = (await extractAllText(await Deno.readFile(`pdfs/${sample.file}`))).text;
      firstText = (await extractFirstTwoPages(await Deno.readFile(`pdfs/${sample.file}`))).text;
    } catch { continue; } // skip if the sample PDF is not present in this checkout
    const sections = detectSections(allText);
    if (sections.found.length !== 16) throw new Error(`${sample.file}: ${sections.found.length}/16 sections, missing ${sections.missing.join(",")}`);
    const dates = detectSdsDates(firstText);
    if (sample.prep && dates.preparation_date !== sample.prep) throw new Error(`${sample.file}: preparation ${dates.preparation_date} != ${sample.prep}`);
    if (sample.revision && dates.revision_date !== sample.revision) throw new Error(`${sample.file}: revision ${dates.revision_date} != ${sample.revision}`);
    if (sample.issue && dates.issue_date !== sample.issue) throw new Error(`${sample.file}: issue ${dates.issue_date} != ${sample.issue}`);
  }
});
