import { getDocumentProxy } from "npm:unpdf@1.6.2";
import { emptyExtraction, extractionSchema, REQUIRED_REVIEW_FIELDS, type Extraction } from "./schema.ts";

const MIN_USEFUL_TEXT_LENGTH = 300;
const GEMINI_TIMEOUT_MS = 30000;
const SDS_KEYWORDS = [
  "safety data sheet", "sds", "section 1", "identification", "section 2", "hazard identification",
  "cas no", "ghs", "hazard statement", "precautionary statement", "manufacturer", "supplier", "emergency contact"
];

const GEMINI_PROMPT = `Extract information from this Safety Data Sheet text. Return JSON only. Do not invent missing data. If a field is not found, return null. Identify the formal product name exactly as written in the SDS. Also identify whether the file is likely a valid SDS. Provide confidence score from 0 to 100 and explain review_required_reason in short text.`;

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
  result.is_likely_sds = assessment.isLikelySds;
  result.product_name = firstLabel(text, ["Product name", "Product identifier", "Material name", "Nama produk"]);
  result.trade_name = firstLabel(text, ["Trade name", "Nama dagangan"]);
  result.supplier = firstLabel(text, ["Supplier", "Supplier name", "Pembekal"]);
  result.manufacturer = firstLabel(text, ["Manufacturer", "Manufactured by", "Pengilang"]);
  result.issue_date = firstLabel(text, ["Issue date", "Date of issue", "Tarikh terbitan"]);
  result.revision_date = firstLabel(text, ["Revision date", "Date of revision", "SDS Date Of Preparation", "Preparation date", "Tarikh semakan"]);
  result.recommended_use = firstLabel(text, ["Recommended use", "Product use", "Identified uses", "Kegunaan yang disarankan"]);
  result.signal_word = firstMatch(text, /\b(DANGER|WARNING|AMARAN|BAHAYA)\b/i)?.toUpperCase() || null;
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
    if (["product_name", "trade_name", "supplier", "manufacturer", "issue_date", "revision_date", "recommended_use"].includes(key)) {
      merged[key] = hasValue(regexValue) ? regexValue : (geminiValue ?? merged[key]);
    } else if (Array.isArray(merged[key])) {
      merged[key] = uniqueValues([...(Array.isArray(regexValue) ? regexValue : []), ...(Array.isArray(geminiValue) ? geminiValue : [])]);
    } else {
      merged[key] = hasValue(geminiValue) ? geminiValue : (regexValue ?? merged[key]);
    }
  }
  // A labelled Trade Name in Section 1 is a stronger formal product identifier than a
  // model-inferred generic Chemical Name (for example, "Organic Mixture").
  if (!regexResult.product_name && regexResult.trade_name) merged.product_name = regexResult.trade_name;
  merged.is_likely_sds = Boolean(regexResult.is_likely_sds || geminiResult?.is_likely_sds);
  merged.possible_duplicate_flag = Boolean(options.duplicate);
  merged.extraction_confidence = Math.max(regexResult.extraction_confidence || 0, geminiResult?.extraction_confidence || 0);
  merged.missing_fields = calculateMissingFields(merged as unknown as Extraction);
  merged.review_required_reason = buildReviewReason(merged as unknown as Extraction, Boolean(options.ocrRequired), Boolean(options.duplicate));
  return extractionSchema.parse(merged);
}

export function calculateMissingFields(result: Extraction) {
  return REQUIRED_REVIEW_FIELDS.filter((field) => !hasValue(result[field]));
}

export function buildReviewReason(result: Extraction, ocrRequired: boolean, duplicate: boolean) {
  const reasons: string[] = [];
  if (ocrRequired) reasons.push("PDF text was weak or empty; OCR or visual verification is required");
  if (!result.is_likely_sds) reasons.push("Document did not contain enough SDS structure markers");
  if (duplicate) reasons.push("Possible duplicate detected");
  if (result.extraction_confidence < 90) reasons.push(`Extraction confidence is ${Math.round(result.extraction_confidence)}%`);
  const missing = calculateMissingFields(result);
  if (missing.length) reasons.push(`Missing review fields: ${missing.join(", ")}`);
  reasons.push("EHS approval is required before publication");
  return [...new Set(reasons)].join(". ");
}

function firstLabel(text: string, labels: string[]) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(text || "").match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:\\-]\\s*([^\\n]{2,300})`, "i"));
    if (match) return cleanValue(match[1]);
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
function hasValue(value: unknown) { return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== ""; }
function uniqueValues(values: unknown[]) { return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]; }
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function nullableString() { return { type: "STRING", nullable: true }; }
function stringArray() { return { type: "ARRAY", items: { type: "STRING" } }; }
