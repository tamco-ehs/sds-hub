import type { Extraction } from "./schema.ts";
import { toIsoDate } from "./extraction.ts";

export const REVIEW_DECISIONS = [
  "no_review_required_existing_unchanged",
  "auto_prescreen_pass",
  "quick_check_required",
  "full_review_required",
  "ocr_review_required",
  "conflict_duplicate",
  "not_sds_or_replace_file",
  "error_needs_review"
] as const;

export type ReviewDecision = typeof REVIEW_DECISIONS[number];
export type RiskLevel = "low" | "medium" | "high" | "unknown";

export type ReviewClassification = {
  riskLevel: RiskLevel;
  decision: ReviewDecision;
  reasons: string[];
  evidence: Record<string, string>;
  aiShouldVerify: boolean;
};

type ClassificationOptions = {
  fullText?: string;
  sectionsFound?: number[];
  missingSections?: number[];
  ocrRequired?: boolean;
  duplicate?: boolean;
  existingApprovedUnchanged?: boolean;
  extractionConflicts?: string[];
  legacyMsds?: boolean;
  fatalError?: string;
};

const HIGH_HAZARD_CODES = new Set([
  "H300", "H301", "H310", "H311", "H314", "H317", "H330", "H331",
  "H334", "H340", "H341", "H350", "H351", "H360", "H361", "H370", "H371", "H372"
]);
const HIGH_RISK_TERMS = [
  "danger", "toxic", "fatal", "corrosive", "highly flammable", "flammable", "oxidizer", "oxidising",
  "explosive", "carcinogenic", "mutagenic", "reproductive toxicity", "respiratory sensitizer",
  "acute toxicity", "compressed gas"
];
const CRITICAL_SECTIONS = new Set([1, 2, 8]);

export function classifySdsReview(metadata: Extraction, options: ClassificationOptions = {}): ReviewClassification {
  const reasons: string[] = [];
  const conflicts = unique(options.extractionConflicts || []);
  const missingSections = uniqueNumbers(options.missingSections || []);
  const evidence = buildEvidence(metadata, options.fullText || "");
  const highCodes = hazardCodes(metadata, evidence.section_2).filter((code) => HIGH_HAZARD_CODES.has(code));
  const signal = String(metadata.signal_word || "").toUpperCase();
  const hazardCount = (metadata.hazard_statements || []).length;
  const highTerms = HIGH_RISK_TERMS.filter((term) => containsTerm(evidence.section_2 || "", term));
  const riskLevel: RiskLevel = highCodes.length || highTerms.length || signal === "DANGER" || signal === "BAHAYA"
    ? "high"
    : missingSections.includes(2)
      ? "unknown"
    : hazardCount || signal === "WARNING" || signal === "AMARAN"
      ? "medium"
      : metadata.is_likely_sds ? "low" : "unknown";

  if (options.fatalError) {
    return result("error_needs_review", "unknown", [`Pre-screen failed: ${options.fatalError}`], evidence, true);
  }
  if (highCodes.length) reasons.push(`High-consequence hazard code(s): ${highCodes.join(", ")}`);
  if (highTerms.length) reasons.push(`High-risk Section 2 term(s): ${highTerms.join(", ")}`);
  if (riskLevel === "high" && !highCodes.length) reasons.push(`High-risk signal word detected: ${signal}`);
  if (missingSections.length) reasons.push(`Incomplete SDS: numeric section(s) ${missingSections.join(", ")} of 16 not found`);
  else if (options.legacyMsds) reasons.push("Legacy MSDS / non-standard section order: all 16 numeric sections present but several titles differ from the current GHS/CLASS order — confirm during EHS review");
  if (metadata.missing_fields?.length) reasons.push(`Missing review field(s): ${metadata.missing_fields.join(", ")}`);
  reasons.push(...(metadata.date_detection_warnings || []));
  reasons.push(...conflicts);

  if (options.existingApprovedUnchanged && !conflicts.length) {
    return result(
      "no_review_required_existing_unchanged", riskLevel,
      ["Exact file hash matches an existing approved SDS; no metadata change was detected"], evidence, false
    );
  }
  if (options.duplicate || metadata.possible_duplicate_flag) {
    return result("conflict_duplicate", riskLevel, ["Possible duplicate must be resolved before publication", ...reasons], evidence, conflicts.length > 0);
  }
  if (!metadata.is_likely_sds && metadata.extraction_confidence < 60) {
    return result("not_sds_or_replace_file", riskLevel, ["Document lacks sufficient SDS structure or readable content", ...reasons], evidence, true);
  }
  if (options.ocrRequired) {
    return result("ocr_review_required", riskLevel, ["Native PDF text is weak or unreadable; OCR/visual verification is required", ...reasons], evidence, true);
  }

  const missingCritical = missingSections.filter((section) => CRITICAL_SECTIONS.has(section));
  const missingIdentity = !metadata.product_name && !metadata.trade_name;
  const missingCompany = !metadata.manufacturer && !metadata.supplier;
  if (riskLevel === "high" || missingCritical.length || missingIdentity || missingCompany || metadata.extraction_confidence < 70 || conflicts.length) {
    if (missingCritical.length) reasons.unshift(`Critical SDS section(s) missing: ${missingCritical.join(", ")}`);
    if (missingIdentity) reasons.unshift("Product/trade name was not reliably detected");
    if (missingCompany) reasons.unshift("Manufacturer/supplier was not reliably detected");
    return result("full_review_required", riskLevel, reasons, evidence, riskLevel === "high" || metadata.extraction_confidence < 85 || missingIdentity || missingCompany || conflicts.length > 0);
  }

  const ambiguousDate = (metadata.date_detection_warnings || []).some((warning) => /ambiguous|multiple sds dates|print date/i.test(warning));
  if (metadata.extraction_confidence < 85 || ambiguousDate || missingSections.length || metadata.missing_fields.length) {
    return result("quick_check_required", riskLevel, reasons.length ? reasons : ["A focused EHS check is required"], evidence, metadata.extraction_confidence < 85);
  }

  return result(
    "auto_prescreen_pass", riskLevel,
    ["Rule-based extraction is complete and internally consistent; controlled approval is still required before publication"], evidence, false
  );
}

export function findExtractionConflicts(regex: Extraction, ai: Extraction | null) {
  if (!ai) return [];
  const conflicts: string[] = [];
  // Product name conflicts only when both sides have a name and NO rule name aligns with ANY AI
  // name — ignoring SDS/MSDS prefixes, file extensions, verbosity (containment), and shared codes.
  // Only present names are compared; a missing name on either side must not silently "align".
  const ruleNames = [regex.product_name, regex.trade_name].filter(Boolean);
  const aiNames = [ai.product_name, ai.trade_name].filter(Boolean);
  if (ruleNames.length && aiNames.length && !ruleNames.some((rule) => aiNames.some((value) => productNamesAlign(rule, value)))) {
    conflicts.push("Rule and AI extraction disagree on product name");
  }
  // Compare dates by calendar value (ISO), never by surface format, and only the SAME label type —
  // so "2016-03-31" vs "31/03/2016" is not a conflict, and supersedes/issue/prep are never cross-compared.
  for (const field of ["revision_date", "issue_date"] as (keyof Extraction)[]) {
    const left = toIsoDate(regex[field]) || normalized(regex[field]);
    const right = toIsoDate(ai[field]) || normalized(ai[field]);
    if (left && right && left !== right) conflicts.push(`Rule and AI extraction disagree on ${String(field).replaceAll("_", " ")}`);
  }
  const ruleSignal = normalized(regex.signal_word); const aiSignal = normalized(ai.signal_word);
  if (ruleSignal && aiSignal && ruleSignal !== aiSignal) conflicts.push("Rule and AI extraction disagree on signal word");
  return conflicts;
}

function productNamesAlign(a: unknown, b: unknown) {
  const na = normProductName(a); const nb = normProductName(b);
  if (!na || !nb) return true; // one side missing is not a conflict
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const tokensA = na.split(" ").filter((token) => token.length >= 3);
  const tokensB = new Set(nb.split(" ").filter((token) => token.length >= 3));
  return tokensA.some((token) => tokensB.has(token)); // share a meaningful token / product code
}

function normProductName(value: unknown) {
  return String(value ?? "").toLowerCase()
    .replace(/\b(?:m?sds|safety data sheet|material safety data sheet)\b/g, " ")
    .replace(/\.(?:pdf|docx?)$/i, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function result(decision: ReviewDecision, riskLevel: RiskLevel, reasons: string[], evidence: Record<string, string>, aiShouldVerify: boolean): ReviewClassification {
  return { decision, riskLevel, reasons: unique(reasons.filter(Boolean)), evidence, aiShouldVerify };
}

function buildEvidence(metadata: Extraction, text: string) {
  const evidence: Record<string, string> = {};
  const section1 = sectionSnippet(text, 1);
  const section2 = sectionSnippet(text, 2);
  const section8 = sectionSnippet(text, 8);
  if (section1) evidence.section_1 = section1;
  if (section2) evidence.section_2 = section2;
  if (section8) evidence.section_8 = section8;
  const dates = [
    metadata.revision_date && `Revision: ${metadata.revision_date}`,
    metadata.issue_date && `Issue: ${metadata.issue_date}`,
    metadata.preparation_date && `Preparation: ${metadata.preparation_date}`,
    metadata.print_date && `Print: ${metadata.print_date}`
  ].filter(Boolean).join("; ");
  if (dates) evidence.dates = dates.slice(0, 500);
  return evidence;
}

function sectionSnippet(text: string, section: number) {
  const source = String(text || "");
  const heading = new RegExp(`(?:^|\\n)\\s*(?:section\\s*)?0?${section}\\s*(?:[.\\-:\\u2013\\u2014]|\\s)`, "im");
  const match = heading.exec(source);
  if (!match) return "";
  const tail = source.slice(match.index, match.index + 1800);
  const next = new RegExp(`\\n\\s*(?:section\\s*)?0?${section + 1}\\s*(?:[.\\-:\\u2013\\u2014]|\\s)`, "im").exec(tail.slice(1));
  const snippet = next ? tail.slice(0, next.index + 1) : tail;
  return snippet.replace(/\\s+/g, " ").trim().slice(0, 700);
}

function hazardCodes(metadata: Extraction, section2 = "") {
  const source = [...(metadata.hazard_statements || []), section2].join(" ");
  return unique((source.match(/\bH\d{3}\b/gi) || []).map((code) => code.toUpperCase()));
}

function normalized(value: unknown) {
  if (value === null || value === undefined || Array.isArray(value) || typeof value === "object") return "";
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function containsTerm(value: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(value);
}

function unique(values: string[]) { return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]; }
function uniqueNumbers(values: number[]) { return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 1 && value <= 16))]; }
