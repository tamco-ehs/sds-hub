import { getDocumentProxy } from "npm:unpdf@1.6.2";
import { emptyExtraction, extractionSchema, REQUIRED_REVIEW_FIELDS, type Extraction } from "./schema.ts";

const MIN_USEFUL_TEXT_LENGTH = 300;
const GEMINI_TIMEOUT_MS = 30000;
const SDS_KEYWORDS = [
  "safety data sheet", "sds", "section 1", "identification", "section 2", "hazard identification",
  "cas no", "ghs", "hazard statement", "precautionary statement", "manufacturer", "supplier", "emergency contact"
];

const GEMINI_PROMPT = `Extract information from this Safety Data Sheet (SDS/MSDS) and return JSON only matching the schema. Do not invent data; if a field is not found, return null.
Rules:
- Product name: take it from the document header or Section 1 (product identifier / trade name) exactly as written. Never use a file name.
- Supplier: use supplier, manufacturer, company, or responsible party. A manufacturer alone is acceptable as the responsible party.
- Dates: capture the dates as written; do not turn a preparation date into a revision date.
- Sections: do NOT mark a section missing only because its title differs from modern GHS/CLASS wording. First confirm the numeric headings SECTION 1 to SECTION 16. If all numeric sections exist but the topic order differs, it is a legacy MSDS / non-standard order, NOT an incomplete SDS.
- You only extract and summarise. Do not decide section completeness, duplicates, or publication status; the application decides those with deterministic rules.
Provide extraction_confidence 0-100 and a short review_required_reason.`;

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: [
    "is_likely_sds", "product_name", "trade_name", "supplier", "manufacturer", "language", "issue_date",
    "revision_date", "cas_numbers", "signal_word", "ghs_pictograms", "hazard_statements",
    "precautionary_statements", "recommended_use", "ppe_recommendation", "storage_summary",
    "first_aid_summary", "spill_response_summary", "firefighting_summary", "disposal_summary",
    "extraction_confidence", "missing_fields", "possible_duplicate_flag", "review_required_reason"
  ],
  properties: {
    is_likely_sds: { type: "BOOLEAN" }, product_name: nullableString(), trade_name: nullableString(),
    supplier: nullableString(), manufacturer: nullableString(), language: nullableString(), issue_date: nullableString(),
    revision_date: nullableString(), cas_numbers: stringArray(), signal_word: nullableString(),
    ghs_pictograms: stringArray(), hazard_statements: stringArray(), precautionary_statements: stringArray(),
    recommended_use: nullableString(), ppe_recommendation: nullableString(), storage_summary: nullableString(),
    first_aid_summary: nullableString(), spill_response_summary: nullableString(), firefighting_summary: nullableString(),
    disposal_summary: nullableString(), extraction_confidence: { type: "NUMBER", minimum: 0, maximum: 100 },
    missing_fields: stringArray(), possible_duplicate_flag: { type: "BOOLEAN" }, review_required_reason: nullableString()
  }
};

export async function extractFirstTwoPages(pdfBytes: Uint8Array) {
  const pdf = await getDocumentProxy(pdfBytes);
  const totalPages = pdf.numPages;
  const pageCount = Math.min(2, totalPages);
  const pageTexts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item) || typeof item.str !== "string") continue;
        pageText += item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ");
      }
      pageTexts.push(pageText.trim());
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return { text: pageTexts.join("\n\n--- PAGE BREAK ---\n\n").trim(), pagesExtracted: pageCount, totalPages };
}

// Read text from across the document (sections 9-16 fall on later pages) so the
// 16-section completeness check can see all headers. Capped to keep parsing bounded.
export async function extractAllText(pdfBytes: Uint8Array, maxPages = 24) {
  const pdf = await getDocumentProxy(pdfBytes);
  const pageCount = Math.min(maxPages, pdf.numPages);
  const pageTexts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => ("str" in item && typeof item.str === "string" ? item.str : "")).join(" "));
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return { text: pageTexts.join("\n").trim(), pagesExtracted: pageCount, totalPages: pdf.numPages };
}

// The 16 mandatory SDS section headers under DOSH Malaysia CLASS Regulations 2013,
// matched in English and Bahasa Malaysia. A document missing any section is flagged
// incomplete during EHS review.
export const SDS_SECTION_TITLES: Record<number, string> = {
  1: "Identification", 2: "Hazard identification", 3: "Composition / ingredients",
  4: "First-aid measures", 5: "Fire-fighting measures", 6: "Accidental release measures",
  7: "Handling and storage", 8: "Exposure controls / personal protection",
  9: "Physical and chemical properties", 10: "Stability and reactivity",
  11: "Toxicological information", 12: "Ecological information", 13: "Disposal considerations",
  14: "Transport information", 15: "Regulatory information", 16: "Other information"
};

// Broadened title synonyms (English + Bahasa Malaysia, stems) used to recognise a numbered SDS
// heading regardless of exact wording. Each keyword is matched within ~90 chars AFTER the section
// number, so the number anchors it to the right section.
const SDS_SECTION_KEYWORDS: Record<number, string[]> = {
  1: ["identification", "identity", "pengenalan"],
  2: ["hazard", "bahaya"],
  3: ["composition", "ingredient", "komposisi", "ramuan"],
  4: ["first-aid", "first aid", "pertolongan cemas", "pertolongan"],
  5: ["fire-fighting", "fire fighting", "firefighting", "fire and explosion", "fire", "kebakaran", "pemadaman"],
  6: ["accidental release", "spill", "leak", "pelepasan", "tumpahan", "kebocoran"],
  7: ["handling and storage", "handling", "storage", "pengendalian", "penyimpanan", "special precaution"],
  8: ["exposure control", "exposure", "personal protection", "personal protective", "ppe", "pendedahan", "perlindungan"],
  9: ["physical and chemical", "physical data", "physical & chemical", "physical", "sifat fizikal", "fizikal"],
  10: ["stability and reactivity", "stability", "reactivity", "kestabilan", "kereaktifan"],
  11: ["toxicolog", "toxicity", "toxicity data", "health hazard data", "toksikologi", "ketoksikan"],
  12: ["ecolog", "ecotoxic", "environmental", "ekologi", "persekitaran", "alam sekitar"],
  13: ["disposal", "waste", "pelupusan", "pembuangan"],
  14: ["transport", "shipping", "pengangkutan", "perkapalan"],
  15: ["regulat", "regulation", "peraturan", "pengawalseliaan", "perundangan"],
  16: ["other information", "others information", "maklumat lain", "maklumat tambahan", "additional information"]
};

// Two independent checks, so a complete legacy MSDS is never reported as "incomplete":
//   - NUMERIC completeness: is the heading "SECTION N" / "N." present, regardless of title?
//   - TOPIC alignment: does section N carry its modern GHS/CLASS title keyword?
// A document is only "missing" a section when the NUMBER is absent. If all 16 numbers are
// present but several titles do not align with the modern order, it is a legacy / non-standard
// MSDS (hold for EHS review), not an incomplete SDS.
export function detectSections(text: string) {
  const source = String(text || "");
  const found: number[] = [];
  const missing: number[] = [];
  const topicAligned: number[] = [];
  for (let section = 1; section <= 16; section += 1) {
    const aligned = hasAlignedTitle(source, section);
    if (aligned) topicAligned.push(section);
    // Numerically present = an explicit SECTION/BAHAGIAN marker OR a numbered heading carrying a
    // recognised SDS title. Bare numeric table rows with no SDS title are not counted.
    (hasNumericSection(source, section) || aligned ? found : missing).push(section);
  }
  const numericComplete = missing.length === 0;
  const missingTopics: number[] = [];
  for (let section = 1; section <= 16; section += 1) if (!topicAligned.includes(section)) missingTopics.push(section);
  // Numerically whole but several titles out of modern order -> treat as legacy MSDS.
  const legacyMsds = numericComplete && topicAligned.length < 14;
  return {
    found, missing, confidence: Math.round((found.length / 16) * 100),
    topicAligned, missingTopics, numericComplete, legacyMsds
  };
}

// Explicit section marker "SECTION N" / "SEKSYEN N" / "BAHAGIAN N", tolerant of spaces split inside
// the word by PDF text extraction (e.g. "SECTI ON 3").
function hasNumericSection(source: string, section: number) {
  return new RegExp(`\\b(?:s\\s*e\\s*c\\s*t\\s*i\\s*o\\s*n|s\\s*e\\s*k\\s*s\\s*y\\s*e\\s*n|b\\s*a\\s*h\\s*a\\s*g\\s*i\\s*a\\s*n)\\s*0?${section}\\b`, "i").test(source);
}

// Numbered heading carrying a recognised SDS title near the number: "1. Identification",
// "10.Stability" (no space), "SECTION 3 : PHYSICAL...", bilingual titles. The number anchors it.
function hasAlignedTitle(source: string, section: number) {
  // Collapse spaced hyphens so "First - aid" / "Fire - fighting" match the hyphenated keywords.
  const lower = source.toLowerCase().replace(/\s*-\s*/g, "-");
  return SDS_SECTION_KEYWORDS[section].some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:section|seksyen|bahagian)?\\s*0?${section}\\s*[.):\\-\u2013\u2014\\s][^\\n]{0,90}${escaped}`, "i").test(lower);
  });
}

type DateField = "revision_date" | "issue_date" | "preparation_date" | "print_date" | "effective_date" | "establishment_date";

const DATE_LABELS: Record<DateField, string[]> = {
  revision_date: ["Revision date", "Revised date", "Date of revision", "Tarikh ulasan", "Tarikh semakan", "Tarikh disemak", "Revision"],
  issue_date: ["Issue date", "Issued date", "Date of issue", "Tarikh dikeluarkan", "Tarikh keluaran"],
  preparation_date: ["Date of preparation", "SDS Date Of Preparation", "Date of Preparation/Revision", "Preparation date", "Prepared date", "Date prepared", "Tarikh penyediaan", "Tarikh disediakan"],
  print_date: ["Print date", "Printed date", "Printing date", "Tarikh cetakan", "Tarikh dicetak"],
  effective_date: ["Effective date", "Publication date", "SDS date", "Created date", "Creation date", "Tarikh kuat kuasa", "Tarikh penerbitan"],
  establishment_date: ["Establishment date", "Date of establishment"]
};

const DATE_PRIORITY: DateField[] = ["revision_date", "issue_date", "preparation_date", "establishment_date", "effective_date", "print_date"];
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};
const DATE_VALUE_PATTERN = "(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2}\\b|\\d{1,2}[\\s-]+[A-Za-z]{3,9}[\\s-]+\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4}|[A-Za-z]{3,9}[\\s-]+\\d{4})";

export function detectSdsDates(text: string) {
  const source = String(text || "");
  const dates: Record<DateField, string | null> = {
    revision_date: null, issue_date: null, preparation_date: null,
    print_date: null, effective_date: null, establishment_date: null
  };
  const labels: Partial<Record<DateField, string>> = {};
  const warnings: string[] = [];
  // Columnised header (stacked labels, then a block of ": value" rows) — map by position first.
  zipVerticalDates(source, dates, labels);

  for (const field of DATE_PRIORITY) {
    if (dates[field]) continue;
    for (const label of DATE_LABELS[field].sort((a, b) => b.length - a.length)) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Adjacent value, then fall back to a windowed search (tabular label-row/value-row, bilingual
      // label stacks, or other columns put the value within a short distance after the label).
      const match = source.match(new RegExp(`(?:^|\\n|\\r|\\b)${escaped}\\s*(?:[:#]|[-\u2013\u2014])?\\s*(${DATE_VALUE_PATTERN})`, "i"))
        || source.match(new RegExp(`${escaped}\\b[\\s\\S]{0,80}?(${DATE_VALUE_PATTERN})`, "i"));
      if (!match) continue;
      const normalized = normalizeSdsDate(match[1]);
      if (!normalized.value) continue;
      dates[field] = normalized.value;
      labels[field] = label;
      if (normalized.warning) warnings.push(`${label}: ${normalized.warning}`);
      break;
    }
  }

  const basis = DATE_PRIORITY.find((field) => dates[field]) || null;
  const value = basis ? dates[basis] : null;
  const uniqueDates = [...new Set(Object.values(dates).filter(Boolean))];
  if (uniqueDates.length > 1) warnings.push("Multiple SDS dates detected. Please confirm the correct validity basis.");
  if (basis === "print_date") warnings.push("Print date is being used only because no better SDS date was found. EHS confirmation is required.");
  const confidence = !basis ? 0 : basis === "print_date" ? 35 : uniqueDates.length > 1 ? 65 : 90;
  return {
    ...dates,
    detected_date_source: basis ? labels[basis] || basis : null,
    detected_date_confidence: confidence,
    validity_date_basis: basis,
    validity_date_value: value,
    date_detection_warnings: [...new Set(warnings)]
  };
}

// Columnised header: labels stacked on consecutive lines, then a block of ": value" rows. Map each
// label to the value at the same position (e.g. VT-210 "Issued date / Rev. No. / Revised date / Page"
// followed by ": 31/03/08 / : 4 / : 29/04/13 / : 1 of 4").
function zipVerticalDates(source: string, dates: Record<DateField, string | null>, labels: Partial<Record<DateField, string>>) {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^:\s*\S/.test(lines[start])) continue;
    let end = start;
    while (end < lines.length && /^:\s*\S/.test(lines[end])) end += 1;
    const values = lines.slice(start, end).map((line) => line.replace(/^:\s*/, ""));
    const labelLines = lines.slice(start - values.length, start);
    if (values.length < 2 || labelLines.length !== values.length) continue;
    for (let index = 0; index < values.length; index += 1) {
      const labelLine = labelLines[index].toLowerCase();
      const normalized = normalizeSdsDate(values[index]);
      if (!normalized.value) continue;
      if (/revis|ulasan|semakan/.test(labelLine) && !dates.revision_date) { dates.revision_date = normalized.value; labels.revision_date = labelLines[index]; }
      else if (/\bissue|dikeluarkan|keluaran/.test(labelLine) && !dates.issue_date) { dates.issue_date = normalized.value; labels.issue_date = labelLines[index]; }
      else if (/prepar|penyediaan|disediakan/.test(labelLine) && !dates.preparation_date) { dates.preparation_date = normalized.value; labels.preparation_date = labelLines[index]; }
    }
    return;
  }
}

function normalizeSdsDate(raw: string) {
  const value = String(raw || "").trim().replace(/\s+/g, " ");
  let year = 0, month = 0, day = 0;
  let warning = "";
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match.map(Number);
  if (!match) {
    match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (match) {
      const first = Number(match[1]), second = Number(match[2]);
      year = Number(match[3]);
      // Default to day/month/year (Malaysian/EU convention) unless the first field can only be a month.
      if (first <= 12 && second > 12) { month = first; day = second; }
      else { day = first; month = second; }
    }
  }
  if (!match) {
    // Two-digit year, e.g. 29/04/13 -> 2013-04-29.
    match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
    if (match) {
      const first = Number(match[1]), second = Number(match[2]);
      year = 2000 + Number(match[3]);
      if (first <= 12 && second > 12) { month = first; day = second; }
      else { day = first; month = second; }
    }
  }
  if (!match) {
    match = value.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})$/i);
    if (match) { day = Number(match[1]); month = MONTHS[match[2].toLowerCase()] || 0; year = Number(match[3]); }
  }
  if (!match) {
    match = value.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/i);
    if (match) { month = MONTHS[match[1].toLowerCase()] || 0; day = Number(match[2]); year = Number(match[3]); }
  }
  if (!match) {
    // Month and year only, e.g. FEB 2022 -> 2022-02-01 (day unknown, month precision).
    match = value.match(/^([A-Za-z]{3,9})[\s-]+(\d{4})$/i);
    if (match) { month = MONTHS[match[1].toLowerCase()] || 0; year = Number(match[2]); day = 1; if (month) warning = "month precision (day assumed 01)"; }
  }
  if (!validCalendarDate(year, month, day)) return { value: null, warning: "" };
  return { value: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`, warning };
}

// Parse any supported SDS date string to ISO (YYYY-MM-DD), or "" if unparseable. Used to compare
// rule vs AI dates by calendar value rather than surface format ("2016-03-31" === "31/03/2016").
export function toIsoDate(value: unknown): string {
  return normalizeSdsDate(String(value ?? "")).value || "";
}

function validCalendarDate(year: number, month: number, day: number) {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function assessSdsText(text: string) {
  const normalized = String(text || "").toLowerCase();
  const keywordHits = SDS_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  const weakText = normalized.replace(/\s+/g, " ").trim().length < MIN_USEFUL_TEXT_LENGTH;
  const hasSectionEvidence = (
    (normalized.includes("section 1") || normalized.includes("1. identification") || normalized.includes("1 - chemical"))
    && (normalized.includes("section 2") || normalized.includes("2. hazard") || normalized.includes("2 \u2013 hazard"))
  );
  return {
    keywordHits, weakText,
    isLikelySds: keywordHits.length >= 4 || (keywordHits.length >= 2 && hasSectionEvidence),
    score: Math.min(100, keywordHits.length * 7 + (hasSectionEvidence ? 20 : 0) + (!weakText ? 10 : 0))
  };
}

export function extractWithRegex(text: string) {
  const result = emptyExtraction();
  const assessment = assessSdsText(text);
  const dates = detectSdsDates(text);
  result.is_likely_sds = assessment.isLikelySds;
  result.product_name = cleanProductName(firstLabel(text, ["Product name", "Product identifier", "Material name", "Nama produk"]));
  result.trade_name = cleanProductName(firstLabel(text, ["Trade name", "Nama dagangan"]));
  result.supplier = firstLabel(text, ["Syarikat", "Supplier's Name", "Supplier name", "Supplier", "Company name", "Company", "Responsible party", "Distributed by", "Pembekal"]);
  result.manufacturer = firstLabel(text, ["Manufacturer's Name", "Manufacturers Name", "Manufacturer name", "Manufacturer", "Manufactured by", "Manufacturer / Supplier", "Pengilang"]);
  result.issue_date = dates.issue_date;
  result.revision_date = dates.revision_date;
  result.preparation_date = dates.preparation_date;
  result.print_date = dates.print_date;
  result.effective_date = dates.effective_date;
  result.establishment_date = dates.establishment_date;
  result.detected_date_source = dates.detected_date_source;
  result.detected_date_confidence = dates.detected_date_confidence;
  result.validity_date_basis = dates.validity_date_basis;
  result.validity_date_value = dates.validity_date_value;
  result.date_detection_warnings = dates.date_detection_warnings;
  result.recommended_use = firstLabel(text, ["Recommended use", "Product use", "Identified uses", "Kegunaan yang disarankan"]);
  const rawSignal = firstMatch(text, /\b(DANGER|WARNING|AMARAN|BAHAYA)\b/i)?.toUpperCase() || null;
  result.signal_word = rawSignal === "BAHAYA" ? "DANGER" : rawSignal === "AMARAN" ? "WARNING" : rawSignal;
  // A product explicitly not classified as hazardous has no GHS signal word by design — record that
  // fact so the absent signal word is informative, not a false "missing field" (e.g. VT-210).
  if (!result.signal_word && /\bnot\s+classified\b|\bnot\s+(?:a\s+)?hazardous\b|not classified as (?:a\s+)?(?:dangerous|hazardous)|non-hazardous|tidak\s+dikelaskan|bukan\s+(?:bahan\s+)?berbahaya/i.test(text)) {
    result.signal_word = "Not classified";
  }
  result.language = detectLanguage(text);
  result.cas_numbers = uniqueMatches(text, /\b\d{2,7}-\d{2}-\d\b/g);
  result.hazard_statements = extractStatements(text, /\bH\d{3}(?:\+H\d{3})?\b[^\n]*/gi);
  result.precautionary_statements = extractStatements(text, /\bP\d{3}(?:\+P\d{3})*\b[^\n]*/gi);
  result.ghs_pictograms = inferPictograms(text);
  result.first_aid_summary = extractSectionSummary(text, 4);
  result.firefighting_summary = extractSectionSummary(text, 5);
  result.spill_response_summary = extractSectionSummary(text, 6);
  result.storage_summary = extractSectionSummary(text, 7);
  result.ppe_recommendation = extractSectionSummary(text, 8);
  result.disposal_summary = extractSectionSummary(text, 13);
  result.extraction_confidence = Math.min(95, Math.round(
    assessment.score * 0.55 + (result.product_name || result.trade_name ? 18 : 0)
    + (result.supplier || result.manufacturer ? 10 : 0) + (result.revision_date || result.issue_date ? 7 : 0)
    + (result.signal_word ? 5 : 0)
  ));
  result.missing_fields = calculateMissingFields(result);
  result.review_required_reason = buildReviewReason(result, assessment.weakText, false);
  return extractionSchema.parse(result);
}

export function shouldUseGemini(regexResult: Extraction, weakText: boolean, apiKey?: string) {
  return Boolean(apiKey) && (
    weakText || regexResult.extraction_confidence < 95 || regexResult.missing_fields.length > 0 || !regexResult.is_likely_sds
  );
}

export async function extractWithGemini(pdfBytes: Uint8Array, extractedText: string, apiKey: string, model = "gemini-2.5-flash") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: "You extract SDS metadata for EHS review. Use only the supplied PDF and text. Never invent data. Return JSON matching the response schema and nothing else." }] },
        contents: [{ role: "user", parts: [
          { text: `${GEMINI_PROMPT}\n\nFirst-page extraction:\n${String(extractedText || "").slice(0, 40000)}` },
          { inline_data: { mime_type: "application/pdf", data: bytesToBase64(pdfBytes) } }
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: "application/json", responseSchema: GEMINI_RESPONSE_SCHEMA }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Gemini extraction returned HTTP ${response.status}`);
    const payload = await response.json();
    const output = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text).filter(Boolean).join("").trim();
    if (!output) throw new Error("Gemini extraction returned no JSON");
    return extractionSchema.parse(JSON.parse(output));
  } finally {
    clearTimeout(timeout);
  }
}

export function mergeExtraction(regexResult: Extraction, geminiResult: Extraction | null, options: { ocrRequired?: boolean; duplicate?: boolean } = {}) {
  const merged = emptyExtraction() as Record<string, unknown>;
  for (const key of Object.keys(merged)) {
    const regexValue = (regexResult as unknown as Record<string, unknown>)?.[key];
    const geminiValue = (geminiResult as unknown as Record<string, unknown> | null)?.[key];
    if (["product_name", "trade_name", "supplier", "manufacturer", "issue_date", "revision_date", "preparation_date", "print_date", "effective_date", "establishment_date", "detected_date_source", "detected_date_confidence", "validity_date_basis", "validity_date_value", "recommended_use"].includes(key)) {
      merged[key] = hasValue(regexValue) ? regexValue : (geminiValue ?? merged[key]);
    } else if (Array.isArray(merged[key])) {
      merged[key] = uniqueValues([...(Array.isArray(regexValue) ? regexValue : []), ...(Array.isArray(geminiValue) ? geminiValue : [])]);
    } else {
      merged[key] = hasValue(geminiValue) ? geminiValue : (regexValue ?? merged[key]);
    }
  }
  // Choose the best Section-1 product identifier: prefer a labelled product/trade
  // name over a generic chemical name (e.g. "Organic Mixture"), cleaned of SDS/version
  // junk. Falls through regex then Gemini candidates.
  const chosenName = chooseProductName(regexResult, geminiResult);
  if (chosenName) merged.product_name = chosenName;
  merged.is_likely_sds = Boolean(regexResult.is_likely_sds || geminiResult?.is_likely_sds);
  merged.possible_duplicate_flag = Boolean(options.duplicate);
  merged.extraction_confidence = Math.max(regexResult.extraction_confidence || 0, geminiResult?.extraction_confidence || 0);
  merged.missing_fields = calculateMissingFields(merged as unknown as Extraction);
  merged.review_required_reason = buildReviewReason(merged as unknown as Extraction, Boolean(options.ocrRequired), Boolean(options.duplicate));
  return extractionSchema.parse(merged);
}

export function calculateMissingFields(result: Extraction) {
  // Supplier and manufacturer are interchangeable for the "responsible party" requirement:
  // a present manufacturer satisfies supplier, and vice versa.
  const hasResponsibleParty = hasValue(result.supplier) || hasValue(result.manufacturer);
  return REQUIRED_REVIEW_FIELDS.filter((field) => {
    if (field === "supplier" || field === "manufacturer") return !hasResponsibleParty;
    return !hasValue(result[field]);
  });
}

export function buildReviewReason(result: Extraction, ocrRequired: boolean, duplicate: boolean) {
  const reasons: string[] = [];
  if (ocrRequired) reasons.push("PDF text was weak or empty; OCR or visual verification is required");
  if (!result.is_likely_sds) reasons.push("Document did not contain enough SDS structure markers");
  if (duplicate) reasons.push("Possible duplicate detected");
  if (result.extraction_confidence < 90) reasons.push(`Extraction confidence is ${Math.round(result.extraction_confidence)}%`);
  reasons.push(...(result.date_detection_warnings || []));
  const missing = calculateMissingFields(result);
  if (missing.length) reasons.push(`Missing review fields: ${missing.join(", ")}`);
  reasons.push("EHS approval is required before publication");
  return [...new Set(reasons)].join(". ");
}

function firstLabel(text: string, labels: string[]) {
  // Normalise curly apostrophes/accents so labels like "Manufacturer's Name" match.
  const source = String(text || "").replace(/[‘’′´`]/g, "'");
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (a) Label (optionally followed by a bilingual partner label) then a colon and same-line value.
    const inline = source.match(new RegExp(`(?:^|\\n)[^\\n]*?\\b${escaped}\\b[^:\\n]{0,40}[:\\-]\\s*([^\\n]{2,300})`, "i"));
    if (inline && cleanValue(inline[1])) return cleanValue(inline[1]);
    // (b) Column layout with no colon: "Manufacturer   AEV LIMITED", "Product Name   SPU 6-92S".
    const spaced = source.match(new RegExp(`(?:^|\\n)[^\\n]*?\\b${escaped}\\b {2,}([A-Za-z0-9][^\\n]{2,200})`, "i"));
    if (spaced && cleanValue(spaced[1])) return cleanValue(spaced[1]);
    // (c) Label alone on its line, value on the next line: "NAMA PRODUK\nNITRIC ACID 68%".
    const stacked = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:\\-]?\\s*\\r?\\n\\s*([^\\n]{2,200})`, "i"));
    if (stacked && cleanValue(stacked[1])) return cleanValue(stacked[1]);
  }
  return null;
}

function firstMatch(text: string, pattern: RegExp) { return String(text || "").match(pattern)?.[1] || null; }
function cleanValue(value: unknown) { return String(value || "").replace(/\s+/g, " ").trim().replace(/[;,.]+$/g, "").slice(0, 500) || null; }
function uniqueMatches(text: string, pattern: RegExp) { return uniqueValues(String(text || "").match(pattern) || []); }
function extractStatements(text: string, pattern: RegExp) { return uniqueValues((String(text || "").match(pattern) || []).map(cleanValue)).slice(0, 50); }

function extractSectionSummary(text: string, sectionNumber: number) {
  const source = String(text || "");
  const heading = new RegExp(`(?:^|\\n)\\s*${sectionNumber}\\s*(?:[-.\u2013\u2014]|\\s)\\s*[^\\n]*`, "im");
  const start = heading.exec(source);
  if (!start) return null;
  const remainder = source.slice(start.index + start[0].length);
  const next = new RegExp(`\\n\\s*${sectionNumber + 1}\\s*(?:[-.\u2013\u2014]|\\s)\\s*[^\\n]*`, "im").exec(remainder);
  return (next ? remainder.slice(0, next.index) : remainder).replace(/--- PAGE BREAK ---/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000) || null;
}

function inferPictograms(text: string) {
  const normalized = String(text || "").toLowerCase();
  const mappings: [string, string[]][] = [
    ["flame", ["flammable", "extremely flammable"]], ["gas-cylinder", ["gas under pressure", "compressed gas"]],
    ["corrosion", ["skin corrosion", "serious eye damage"]], ["skull-and-crossbones", ["acute toxicity", "fatal if"]],
    ["exclamation-mark", ["skin irritation", "eye irritation", "harmful if"]],
    ["health-hazard", ["carcinogen", "aspiration hazard", "respiratory sensitization"]],
    ["environment", ["aquatic environment", "toxic to aquatic"]], ["exploding-bomb", ["explosive", "self-reactive"]],
    ["flame-over-circle", ["oxidizing", "oxidiser"]]
  ];
  return mappings.filter(([, terms]) => terms.some((term) => normalized.includes(term))).map(([name]) => name);
}

function detectLanguage(text: string) {
  const normalized = String(text || "").toLowerCase();
  return ["helaian data keselamatan", "bahaya", "pembekal", "kegunaan yang disarankan"].some((term) => normalized.includes(term)) ? "Malay" : "English";
}

const EN_LANGUAGE_INDICATORS = [
  "safety data sheet", "material safety data sheet", "hazard identification", "first-aid", "first aid",
  "exposure control", "handling and storage", "supplier", "revision date", "physical and chemical"
];
const MS_LANGUAGE_INDICATORS = [
  "helaian data keselamatan", "lampiran data keselamatan", "bahagian", "pengenalan bahaya", "pertolongan cemas",
  "kawalan pendedahan", "tarikh penyediaan", "tarikh ulasan", "kata isyarat", "pembekal", "bahaya"
];

// Classify the SDS language for variant grouping: en / ms / bilingual / unknown.
export function detectDocumentLanguage(text: string) {
  const lower = String(text || "").toLowerCase().replace(/\s*-\s*/g, "-");
  const en = EN_LANGUAGE_INDICATORS.filter((term) => lower.includes(term)).length;
  const ms = MS_LANGUAGE_INDICATORS.filter((term) => lower.includes(term)).length;
  const pairedLabels = [
    ["product name", "nama produk"], ["safety data sheet", "helaian data keselamatan"],
    ["preparation date", "tarikh penyediaan"], ["signal word", "kata isyarat"]
  ].some(([eng, mly]) => lower.includes(eng) && lower.includes(mly));
  let language: "en" | "ms" | "bilingual" | "unknown";
  let reason: string;
  if (pairedLabels || (en >= 3 && ms >= 3)) { language = "bilingual"; reason = `English (${en}) and Bahasa Melayu (${ms}) indicators${pairedLabels ? " with paired labels" : ""}`; }
  else if (ms > en && ms >= 2) { language = "ms"; reason = `Bahasa Melayu indicators (${ms})`; }
  else if (en >= 2) { language = "en"; reason = `English indicators (${en})`; }
  else { language = "unknown"; reason = "insufficient language indicators"; }
  const confidence = language === "unknown" ? 20 : Math.min(95, 40 + (en + ms) * 8);
  return { language, confidence, reason };
}

const GENERIC_NAMES = new Set([
  "organic mixture", "chemical mixture", "mixture", "preparation", "substance", "product",
  "article", "not available", "not applicable", "n/a", "na", "none", "sds", "msds",
  "safety data sheet", "material safety data sheet"
]);

function isGenericName(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized.length < 2 || GENERIC_NAMES.has(normalized);
}

// Clean a Section-1 product/trade name of labels and SDS/version junk. Returns null
// if nothing usable or the result is a generic chemical descriptor.
function cleanProductName(value: unknown) {
  let name = cleanValue(value);
  if (!name) return null;
  name = name.replace(/^(?:product\s*name|trade\s*name|material\s*name|product\s*identifier)\s*[:\-]?\s*/i, "");
  // Flattened tables bleed the next column onto the same line; cut at the next labelled column.
  name = name.replace(/\s+(?:file\s*name|issue\s*no\.?|page|use|cas\s*(?:no|number)|product\s*code|grade)\s*[:.\-)].*$/i, "");
  name = name.replace(/[\s\-_(]*\b(?:m?sds|safety data sheet|material safety data sheet)\b[\s\-_)]*$/i, "");
  name = name.replace(/\s*[-_]?\s*(?:v(?:er(?:sion)?)?\.?\s*\d+|rev(?:ision)?\.?\s*[\w.]+)\s*$/i, "");
  name = name.replace(/\s+/g, " ").replace(/[\s\-_(]+$/, "").trim();
  return name && !isGenericName(name) ? name.slice(0, 200) : null;
}

function chooseProductName(regexResult: Extraction, geminiResult: Extraction | null) {
  const candidates = [regexResult?.product_name, regexResult?.trade_name, geminiResult?.product_name, geminiResult?.trade_name];
  for (const candidate of candidates) {
    const cleaned = cleanProductName(candidate);
    if (cleaned) return cleaned;
  }
  return null;
}
function hasValue(value: unknown) { return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== ""; }
function uniqueValues(values: unknown[]) { return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]; }
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function nullableString() { return { type: "STRING", nullable: true }; }
function stringArray() { return { type: "ARRAY", items: { type: "STRING" } }; }
