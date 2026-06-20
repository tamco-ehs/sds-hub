import { z } from "npm:zod@4.4.3";

export const SDS_STATUSES = [
  "Uploaded", "Parsing", "Extracted", "Needs Review", "Approved", "Rejected", "Archived", "Duplicate"
] as const;

const nullableText = z.string().max(5000).nullable();
const nullableShortText = z.string().max(500).nullable();
const textArray = z.array(z.string().max(1000)).max(100);

export const extractionSchema = z.object({
  is_likely_sds: z.boolean(),
  product_name: nullableShortText,
  trade_name: nullableShortText,
  supplier: nullableShortText,
  manufacturer: nullableShortText,
  language: nullableShortText,
  issue_date: nullableShortText,
  revision_date: nullableShortText,
  cas_numbers: textArray,
  signal_word: nullableShortText,
  ghs_pictograms: textArray,
  hazard_statements: textArray,
  precautionary_statements: textArray,
  recommended_use: nullableText,
  ppe_recommendation: nullableText,
  storage_summary: nullableText,
  first_aid_summary: nullableText,
  spill_response_summary: nullableText,
  firefighting_summary: nullableText,
  disposal_summary: nullableText,
  extraction_confidence: z.number().min(0).max(100),
  missing_fields: textArray,
  possible_duplicate_flag: z.boolean(),
  review_required_reason: nullableText
});

export type Extraction = z.infer<typeof extractionSchema>;

export const EDITABLE_FIELDS = [
  "product_name", "trade_name", "supplier", "manufacturer", "language", "issue_date", "revision_date",
  "cas_numbers", "signal_word", "ghs_pictograms", "hazard_statements", "precautionary_statements",
  "recommended_use", "ppe_recommendation", "storage_summary", "first_aid_summary", "spill_response_summary",
  "firefighting_summary", "disposal_summary", "extraction_confidence", "missing_fields",
  "possible_duplicate_flag", "review_required_reason"
] as const;

export const REQUIRED_REVIEW_FIELDS = [
  "product_name", "supplier", "manufacturer", "language", "revision_date", "signal_word", "recommended_use"
] as const;

export function emptyExtraction(): Extraction {
  return {
    is_likely_sds: false,
    product_name: null,
    trade_name: null,
    supplier: null,
    manufacturer: null,
    language: null,
    issue_date: null,
    revision_date: null,
    cas_numbers: [],
    signal_word: null,
    ghs_pictograms: [],
    hazard_statements: [],
    precautionary_statements: [],
    recommended_use: null,
    ppe_recommendation: null,
    storage_summary: null,
    first_aid_summary: null,
    spill_response_summary: null,
    firefighting_summary: null,
    disposal_summary: null,
    extraction_confidence: 0,
    missing_fields: [],
    possible_duplicate_flag: false,
    review_required_reason: null
  };
}

export function pickEditableMetadata(input: Record<string, unknown>): Extraction {
  const metadata: Record<string, unknown> = emptyExtraction();
  for (const field of EDITABLE_FIELDS) {
    if (Object.hasOwn(input || {}, field)) metadata[field] = input[field];
  }
  metadata.is_likely_sds = Boolean(input?.is_likely_sds ?? true);
  return extractionSchema.parse(metadata);
}
