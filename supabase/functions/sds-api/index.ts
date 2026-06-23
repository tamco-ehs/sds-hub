import { assessSdsText, detectDocumentLanguage, detectSections, extractAllText, extractFirstTwoPages, extractWithGemini, extractWithRegex, mergeExtraction } from "../_shared/extraction.ts";
import { generateApprovedFilename, sha256Hex } from "../_shared/filename.ts";
import { deleteRows, insertRows, nowIso, selectRows, updateRows } from "../_shared/database.ts";
import { deleteReleaseAsset, downloadPrivateAsset, uploadApproved, uploadOriginal } from "../_shared/github-releases.ts";
import { classifySdsReview, findExtractionConflicts } from "../_shared/review-classification.ts";
import { normalizeProductName, suggestGrouping } from "../_shared/grouping.ts";
import { emptyExtraction, extractionSchema, pickEditableMetadata, SDS_STATUSES, type Extraction } from "../_shared/schema.ts";
import { computeValidity } from "../_shared/validity.ts";
import { BlobReader, Uint8ArrayWriter, ZipReader } from "npm:@zip.js/zip.js@2.7.57";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_ZIP_ADVERTISED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_EDGE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_PDFS = 20;
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_TEXT_AUDIT_LENGTH = 50000;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ASK_PDF_MAX_BYTES = 12 * 1024 * 1024; // AI/Gemini inline limit — keep modest
const PREVIEW_PDF_MAX_BYTES = 25 * 1024 * 1024; // CORS preview proxy — generous headroom over the 15 MB upload cap
const ASK_RATE_LIMIT = 10;
const ASK_RATE_WINDOW_MS = 60000;
const ASK_GEMINI_TIMEOUT_MS = 25000;
const STATIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let catalogCache: { fetchedAt: number; documents: Record<string, unknown>[] } | null = null;

type EhsRole = "EHS_ADMIN" | "EHS_REVIEWER";
type Actor = { userId: string | null; displayName: string; role: EhsRole; email: string | null; emergency: boolean };

class ApiProblem extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

Deno.serve(async (request) => {
  try {
    return await route(request);
  } catch (error) {
    const detail = safeError(error);
    console.error("SDS API error", detail);
    const adminRequest = apiPath(new URL(request.url).pathname).startsWith("/v1/admin");
    const status = error instanceof ApiProblem ? error.status : 500;
    return json({
      error: error instanceof ApiProblem ? error.message : "The SDS service could not complete the request.",
      ...(adminRequest && status >= 500 ? { detail } : {})
    }, status, corsHeaders(request));
  }
});

async function route(request: Request) {
  const url = new URL(request.url);
  const path = apiPath(url.pathname);
  const cors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    if (!cors) return json({ error: "Origin is not allowed." }, 403);
    return new Response(null, { status: 204, headers: cors });
  }
  if (path === "/v1/catalog" && request.method === "GET") return publicCatalog(cors);
  if (path === "/v1/catalog/file" && request.method === "GET") return streamCatalogFile(url, cors);

  const publicFile = path.match(/^\/v1\/documents\/([a-f0-9-]+)\/file$/i);
  if (publicFile && request.method === "GET") return streamFile(publicFile[1], "approved", false, cors);

  if (path === "/v1/ask" && request.method === "POST") return askQuestion(request, cors);

  if (!path.startsWith("/v1/admin")) return json({ error: "Not found." }, 404, cors);
  const actor = await authenticate(request);

  if (path === "/v1/admin/session" && request.method === "GET") {
    await auditEvent(actor, "LOGIN_SUCCESS", null, null, null, null);
    return json({ user: publicActor(actor) }, 200, cors);
  }

  if (path === "/v1/admin/documents" && request.method === "POST") return uploadDocument(request, cors, requireRole(actor, "EHS_ADMIN"));
  if (path === "/v1/admin/documents" && request.method === "GET") return listDocuments(url, cors, actor);
  if (path === "/v1/admin/dashboard" && request.method === "GET") return dashboard(cors);
  if (path === "/v1/admin/duplicates" && request.method === "GET") return duplicateList(cors);

  const bulkMatch = path.match(/^\/v1\/admin\/documents\/bulk\/(archive|delete|restore|purge)$/i);
  if (bulkMatch && request.method === "POST") return bulkAction(bulkMatch[1].toLowerCase(), request, cors, requireRole(actor, "EHS_ADMIN"));

  const match = path.match(/^\/v1\/admin\/documents\/([a-f0-9-]+)(?:\/(extract|approve|reject|duplicate|group|ungroup|archive|restore|file))?$/i);
  if (!match || !UUID_PATTERN.test(match[1])) return json({ error: "Admin endpoint not found." }, 404, cors);
  const [, id, action = ""] = match;
  if (!action && request.method === "GET") return getDocument(id, cors, actor);
  if (!action && request.method === "PATCH") return saveReview(id, request, cors, actor);
  if (action === "extract" && request.method === "POST") return reextract(id, request, cors, actor);
  if (action === "approve" && request.method === "POST") return approve(id, request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "reject" && request.method === "POST") return changeStatus(id, "Rejected", "REJECT", request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "archive" && request.method === "POST") return changeStatus(id, "Archived", "ARCHIVE", request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "restore" && request.method === "POST") return restoreDocument(id, request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "duplicate" && request.method === "POST") return markDuplicate(id, request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "group" && request.method === "POST") return groupDocument(id, request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "ungroup" && request.method === "POST") return ungroupDocument(id, request, cors, requireRole(actor, "EHS_ADMIN"));
  if (action === "file" && request.method === "GET") return streamFile(id, url.searchParams.get("variant") || "original", true, cors, actor);
  return json({ error: "Method not allowed." }, 405, cors);
}

async function uploadDocument(request: Request, cors: Record<string, string> | null, actor: Actor) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return json({ error: "A PDF or ZIP file is required." }, 400, cors);
  const isZip = /\.zip$/i.test(file.name) || ["application/zip", "application/x-zip-compressed"].includes(file.type);
  if (isZip) return uploadZip(file, cors, actor);
  if (file.size < 5 || file.size > MAX_UPLOAD_BYTES) return json({ error: "PDF must be between 5 bytes and 15 MB." }, 413, cors);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") return json({ error: "The uploaded file does not have a valid PDF signature." }, 400, cors);

  const document = await ingestPdf(String(file.name || "uploaded-sds.pdf"), bytes, actor, null, true);
  return json({ document }, 201, cors);
}

async function ingestPdf(originalName: string, bytes: Uint8Array, actor: Actor, batchId: string | null, allowGemini: boolean) {
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_UPLOAD_BYTES) throw new ApiProblem("PDF exceeds the 15 MB individual file limit.", 413);
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") throw new ApiProblem("PDF unreadable: invalid PDF signature.", 400);

  const id = crypto.randomUUID();
  const originalFilename = String(originalName || "uploaded-sds.pdf").replace(/[\r\n\t]/g, " ").slice(0, 255);
  const digest = await sha256Hex(bytes);
  const duplicates = await selectRows("sds_documents", `select=id,product_name,status&file_sha256=eq.${digest}&order=created_at.desc&limit=1`);
  const duplicate = duplicates[0] || null;
  const asset = await uploadOriginal(id, originalFilename, bytes);
  const now = nowIso();

  await insertRows("sds_documents", {
    id,
    original_filename: originalFilename,
    original_storage_key: asset.assetName,
    original_asset_id: asset.assetId,
    original_download_url: asset.apiUrl,
    file_sha256: digest,
    file_size: bytes.byteLength,
    status: "Uploaded",
    uploaded_by: actor.userId,
    batch_id: batchId,
    possible_duplicate_flag: Boolean(duplicate),
    duplicate_of_id: duplicate?.id || null,
    created_at: now,
    updated_at: now
  }, false);
  const uploaded = await fetchDocument(id);
  await history(id, batchId ? "UPLOAD_ZIP_BATCH" : "UPLOAD_SINGLE_PDF", null, "Uploaded", actor, { original_filename: originalFilename, sha256: digest, batch_id: batchId }, duplicate ? "Exact file hash already exists." : null);
  await auditEvent(actor, batchId ? "UPLOAD_ZIP_BATCH" : "UPLOAD_SINGLE_PDF", uploaded, duplicate ? "Exact file hash already exists." : null, null, { sha256: digest, batch_id: batchId }, batchId);

  try {
    await runExtraction(id, bytes, actor, false, allowGemini);
  } catch (error) {
    const reason = `Extraction failed: ${safeError(error)}`;
    await updateRows("sds_documents", `id=eq.${id}`, {
      status: "Needs Review",
      risk_level: "unknown",
      review_decision: "error_needs_review",
      review_reasons: [reason],
      review_required_reason: reason,
      ai_verification_status: "error",
      prescreened_at: nowIso(),
      updated_at: nowIso()
    }, false);
    await extractionLog(id, "Extraction", "pdf-text", "Error", null, 0, [], null, reason, 0);
  }
  return await fetchDocument(id);
}

async function uploadZip(file: File, cors: Record<string, string> | null, actor: Actor) {
  if (file.size > MAX_ZIP_ADVERTISED_BYTES) return json({ error: "ZIP too large. The configured maximum is 100 MB." }, 413, cors);
  if (file.size > MAX_ZIP_EDGE_BYTES) return json({ error: "ZIP too large for the current Supabase Edge Function intake. Use ZIP files up to 20 MB, or split this batch. The documented 100 MB ceiling is not safe in this runtime." }, 413, cors);

  const reader = new ZipReader(new BlobReader(file));
  let entries: any[] = [];
  try { entries = await reader.getEntries(); }
  catch { await reader.close().catch(() => {}); return json({ error: "The ZIP file is unreadable or corrupt." }, 400, cors); }

  const files = entries.filter((entry) => !entry.directory);
  const unsafe = files.find((entry) => unsafeZipPath(String(entry.filename || "")));
  if (unsafe) { await reader.close(); return json({ error: `Unsafe ZIP path rejected: ${String(unsafe.filename).slice(0, 180)}` }, 400, cors); }
  const pdfEntries = files.filter((entry) => /\.pdf$/i.test(String(entry.filename || "")));
  if (!pdfEntries.length) { await reader.close(); return json({ error: "ZIP contains no PDF files." }, 400, cors); }
  if (pdfEntries.length > MAX_ZIP_PDFS) { await reader.close(); return json({ error: `Too many PDFs in ZIP. Maximum ${MAX_ZIP_PDFS}.` }, 413, cors); }
  const uncompressedTotal = pdfEntries.reduce((sum, entry) => sum + Number(entry.uncompressedSize || 0), 0);
  if (uncompressedTotal > MAX_ZIP_UNCOMPRESSED_BYTES) { await reader.close(); return json({ error: "ZIP expands beyond the 200 MB safety limit." }, 413, cors); }

  const batchId = crypto.randomUUID();
  await insertRows("sds_upload_batches", {
    id: batchId, uploaded_by: actor.userId, uploaded_by_name: actor.displayName, uploaded_by_role: actor.role,
    original_zip_filename: String(file.name || "sds-batch.zip").slice(0, 255), total_files: files.length,
    accepted_pdf_count: 0, rejected_file_count: files.length - pdfEntries.length, status: "Processing"
  }, false);

  const results: Record<string, unknown>[] = files.filter((entry) => !/\.pdf$/i.test(String(entry.filename || ""))).map((entry) => ({
    filename: String(entry.filename || "unnamed"), status: "rejected", reason: "Unsupported file skipped"
  }));
  let accepted = 0, duplicates = 0, failed = 0, rejected = results.length;

  try {
    for (let index = 0; index < pdfEntries.length; index += 1) {
      const entry = pdfEntries[index];
      const filename = String(entry.filename || `document-${index + 1}.pdf`);
      if (Number(entry.uncompressedSize || 0) > MAX_UPLOAD_BYTES) {
        rejected += 1;
        results.push({ filename, status: "rejected", reason: "PDF exceeds size limit (15 MB)" });
        continue;
      }
      try {
        const bytes = await entry.getData(new Uint8ArrayWriter());
        // ZIP runs regex-only (no per-file Gemini) so the whole batch fits in one request without a gateway timeout. For AI-quality extraction, use multi-file select (one request per PDF) or re-extract.
        const document = await ingestPdf(filename.split(/[\\/]/).pop() || filename, bytes, actor, batchId, false);
        accepted += 1;
        if (document?.possible_duplicate_flag) duplicates += 1;
        results.push({
          filename, status: document?.possible_duplicate_flag ? "duplicate" : "processed",
          document_id: document?.id, product_name: document?.product_name || document?.trade_name || null,
          manufacturer: document?.manufacturer || document?.supplier || null,
          date_detected: document?.validity_date_value || null, date_basis_used: document?.validity_date_basis || null,
          sections_complete: Array.isArray(document?.missing_sections) && document.missing_sections.length === 0,
          missing_sections: document?.missing_sections || [],
          reason: document?.ocr_required ? "PDF appears scanned/image-only; OCR review required" : null
        });
      } catch (error) {
        failed += 1;
        results.push({ filename, status: "failed", reason: safeError(error) });
      }
    }
  } finally {
    await reader.close().catch(() => {});
  }

  const status = failed || rejected ? "Completed with warnings" : "Completed";
  await updateRows("sds_upload_batches", `id=eq.${batchId}`, {
    accepted_pdf_count: accepted, rejected_file_count: rejected, duplicate_count: duplicates,
    failed_count: failed, status, results_json: results
  }, false);
  await auditEvent(actor, "UPLOAD_ZIP_BATCH", null, `Processed ZIP ${file.name}`, null, { total_files: files.length, accepted, rejected, duplicates, failed }, batchId);
  return json({ batch: { id: batchId, status, total_files: files.length, accepted_pdf_count: accepted, rejected_file_count: rejected, duplicate_count: duplicates, failed_count: failed }, results }, 201, cors);
}

function unsafeZipPath(filename: string) {
  const normalized = filename.replace(/\\/g, "/");
  return !normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..");
}

async function runExtraction(id: string, suppliedBytes: Uint8Array | null, actor: Actor, forceGemini: boolean, allowGemini = true) {
  const document = await fetchDocument(id);
  if (!document) throw new Error("Document not found");
  await updateRows("sds_documents", `id=eq.${id}`, { status: "Parsing", updated_at: nowIso(), version: document.version + 1 }, false);
  await history(id, "START_EXTRACTION", document.status, "Parsing", actor, null, null);

  const bytes = suppliedBytes || await downloadPrivateAsset(Number(document.original_asset_id));
  let textResult = { text: "", pagesExtracted: 0, totalPages: 0 };
  let textError = "";
  try { textResult = await extractFirstTwoPages(bytes); } catch (error) { textError = safeError(error); }
  let sectionScanText = textResult.text;
  try { const allPages = await extractAllText(bytes); if (allPages.text) sectionScanText = allPages.text; } catch { /* fall back to first-page text */ }
  const sections = detectSections(sectionScanText);
  const docLanguage = detectDocumentLanguage(sectionScanText);
  const assessment = assessSdsText(textResult.text);
  const regex = extractWithRegex(textResult.text);
  const preliminary = classifySdsReview(regex, {
    fullText: sectionScanText,
    sectionsFound: sections.found,
    missingSections: sections.missing,
    ocrRequired: assessment.weakText || Boolean(textError)
  });
  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  let gemini: Extraction | null = null;
  let geminiError = "";
  const geminiNeeded = forceGemini || (allowGemini && preliminary.aiShouldVerify);
  if (geminiNeeded && geminiKey) {
    try { gemini = await extractWithGemini(bytes, textResult.text, geminiKey, model); } catch (error) { geminiError = safeError(error); }
  }

  const candidates = await selectRows("sds_documents", `select=id,product_name,trade_name,supplier,manufacturer,document_language,revision_date,issue_date,preparation_date,effective_date,cas_numbers,file_sha256,status&status=neq.Archived&deleted_at=is.null&archived_at=is.null&limit=1000`);
  const product = regex.product_name || regex.trade_name || gemini?.product_name || gemini?.trade_name;
  const revision = regex.revision_date || gemini?.revision_date || "";
  const metadataDuplicate = product ? candidates.find((item: Record<string, unknown>) => (
    item.id !== id && String(item.product_name || item.trade_name || "").toLowerCase() === product.toLowerCase()
      && String(item.revision_date || "") === revision
  )) : null;
  const activeExistingDuplicate = candidates.find((item: Record<string, unknown>) => item.id === document.duplicate_of_id);
  const duplicateOfId = activeExistingDuplicate?.id || metadataDuplicate?.id || null;
  const merged = mergeExtraction(regex, gemini, { ocrRequired: assessment.weakText || Boolean(textError), duplicate: Boolean(duplicateOfId) });
  const extractionConflicts = findExtractionConflicts(regex, gemini);
  const existingApprovedUnchanged = Boolean(
    activeExistingDuplicate?.status === "Approved" && !extractionConflicts.length
  );
  const classification = classifySdsReview(merged, {
    fullText: sectionScanText,
    sectionsFound: sections.found,
    missingSections: sections.missing,
    ocrRequired: assessment.weakText || Boolean(textError),
    duplicate: Boolean(duplicateOfId),
    existingApprovedUnchanged,
    extractionConflicts,
    legacyMsds: sections.legacyMsds
  });
  // Language-variant grouping: does this look like the EN/BM sibling of an existing SDS?
  const grouping = suggestGrouping(
    {
      id, product_name: merged.product_name, trade_name: merged.trade_name,
      supplier: merged.supplier, manufacturer: merged.manufacturer,
      document_language: docLanguage.language, cas_numbers: merged.cas_numbers,
      file_hash: document.file_sha256, revision_date: merged.revision_date,
      issue_date: merged.issue_date, preparation_date: merged.preparation_date, effective_date: merged.effective_date
    },
    candidates.map((row: Record<string, unknown>) => ({
      id: String(row.id), product_name: row.product_name as string, trade_name: row.trade_name as string,
      supplier: row.supplier as string, manufacturer: row.manufacturer as string,
      document_language: row.document_language as string, cas_numbers: row.cas_numbers as string[],
      file_hash: row.file_sha256 as string, revision_date: row.revision_date as string,
      issue_date: row.issue_date as string, preparation_date: row.preparation_date as string, effective_date: row.effective_date as string
    }))
  );
  const languageVariantOf = grouping.relationship === "language_variant" ? grouping.candidateId : null;
  if (languageVariantOf) {
    const langLabel = docLanguage.language === "ms" ? "Bahasa Melayu" : docLanguage.language === "bilingual" ? "bilingual" : "English";
    classification.reasons.push(`Possible ${langLabel} language variant of "${grouping.candidateProductName}" — confirm or keep separate during EHS review`);
    for (const warning of grouping.warnings) classification.reasons.push(warning);
  }
  // Single deduplicated reason built from the classifier (which already handles numeric-section
  // completeness, legacy MSDS, missing fields, conflicts and date warnings) plus extraction errors.
  const reasonParts = [...classification.reasons];
  // Only surface an AI/OCR gap as a review issue when it actually matters: the PDF needed OCR, or
  // rule-based extraction is itself weak. A readable SDS with solid rule fields is not a failure
  // just because the AI step timed out (the status is still recorded in ai_verification_status).
  const ocrRequired = assessment.weakText || Boolean(textError);
  if (geminiError && (ocrRequired || merged.missing_fields.length > 0 || merged.extraction_confidence < 85)) {
    reasonParts.push(friendlyExtractionNote(geminiError, ocrRequired));
  }
  if (textError) reasonParts.push(`PDF text extraction failed: ${textError}`);
  reasonParts.push("EHS approval is required before publication");
  merged.review_required_reason = [...new Set(reasonParts.filter(Boolean))].join(". ");
  const method = gemini ? (assessment.weakText ? "pdf-text+gemini-ocr" : "pdf-text+regex+gemini") : "pdf-text+regex";
  const aiVerificationStatus = geminiVerificationStatus(geminiNeeded, geminiKey, gemini, geminiError, allowGemini);

  await updateRows("sds_documents", `id=eq.${id}`, {
    ...metadataColumns(merged),
    sections_found: sections.found,
    missing_sections: sections.missing,
    section_detection_confidence: sections.confidence,
    document_language: docLanguage.language,
    language_confidence: docLanguage.confidence,
    language_detection_reason: docLanguage.reason,
    is_bilingual: docLanguage.language === "bilingual",
    language_variant_of: languageVariantOf,
    language_variant_status: languageVariantOf ? "suggested" : "unlinked",
    status: "Extracted",
    ocr_required: assessment.weakText || Boolean(textError),
    extraction_method: method,
    gemini_used: Boolean(gemini),
    extracted_text: textResult.text.slice(0, MAX_TEXT_AUDIT_LENGTH),
    duplicate_of_id: duplicateOfId,
    risk_level: classification.riskLevel,
    review_decision: classification.decision,
    review_reasons: classification.reasons,
    evidence_snippets: classification.evidence,
    extraction_conflicts: extractionConflicts,
    ai_verification_status: aiVerificationStatus,
    existing_catalog_match: existingApprovedUnchanged,
    prescreened_at: nowIso(),
    updated_at: nowIso(),
    version: document.version + 2
  }, false);
  await extractionLog(id, "Extraction", method, geminiError ? "Completed with warning" : "Completed", gemini ? model : null, merged.extraction_confidence, assessment.keywordHits, merged, geminiError || textError, textResult.text.length);
  await history(id, "COMPLETE_EXTRACTION", "Parsing", "Extracted", actor, { extraction_method: method }, null);
  await updateRows("sds_documents", `id=eq.${id}`, { status: "Needs Review", updated_at: nowIso(), version: document.version + 3 }, false);
  await history(id, "ROUTE_TO_EHS_REVIEW", "Extracted", "Needs Review", actor, {
    review_decision: classification.decision,
    risk_level: classification.riskLevel,
    ai_verification_status: aiVerificationStatus
  }, merged.review_required_reason);
}

async function listDocuments(url: URL, cors: Record<string, string> | null, actor: Actor) {
  const status = url.searchParams.get("status") || "";
  const requestedScope = url.searchParams.get("scope") || "active";
  const scope = actor.role === "EHS_ADMIN" ? requestedScope : "active";
  const query = url.searchParams.get("q")?.trim() || "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
  let filter = `select=*&order=updated_at.desc&limit=${limit}`;
  if (scope === "deleted") filter += "&deleted_at=not.is.null";
  else if (scope === "archived") filter += "&deleted_at=is.null&archived_at=not.is.null";
  else if (scope !== "all") filter += "&deleted_at=is.null&archived_at=is.null";
  if ((SDS_STATUSES as readonly string[]).includes(status)) filter += `&status=eq.${encodeURIComponent(status)}`;
  if (query) {
    const safe = query.replace(/[,*()]/g, " ").trim();
    filter += `&or=(product_name.ilike.*${encodeURIComponent(safe)}*,trade_name.ilike.*${encodeURIComponent(safe)}*,original_filename.ilike.*${encodeURIComponent(safe)}*)`;
  }
  return json({ documents: await selectRows("sds_documents", filter) }, 200, cors);
}

async function getDocument(id: string, cors: Record<string, string> | null, actor: Actor) {
  const document = await fetchDocument(id);
  if (!document) return json({ error: "Document not found." }, 404, cors);
  if ((document.deleted_at || document.archived_at) && actor.role !== "EHS_ADMIN") return json({ error: "Role does not allow access to archived or deleted SDS records." }, 403, cors);
  const [logs, reviewHistory, auditEvents, group] = await Promise.all([
    selectRows("sds_extraction_logs", `select=*&document_id=eq.${id}&order=created_at.desc&limit=50`),
    selectRows("sds_review_history", `select=*&document_id=eq.${id}&order=created_at.desc&limit=100`),
    selectRows("sds_audit_events", `select=*&document_id=eq.${id}&order=created_at.desc&limit=100`),
    buildVariantInfo(document)
  ]);
  return json({ document, group, extraction_logs: logs, review_history: reviewHistory, audit_events: auditEvents }, 200, cors);
}

// Assemble the language-variant context an EHS reviewer needs: the suggested sibling (if any),
// the canonical record this document is linked to, and the other language variants under it.
async function buildVariantInfo(document: Record<string, any>) {
  const info: Record<string, unknown> = {
    document_language: document.document_language || "unknown",
    language_confidence: document.language_confidence ?? null,
    language_detection_reason: document.language_detection_reason || null,
    is_bilingual: Boolean(document.is_bilingual),
    language_variant_status: document.language_variant_status || "unlinked",
    suggested_candidate: null,
    record: null,
    linked_variants: []
  };
  if (document.language_variant_of && document.language_variant_status === "suggested") {
    const rows = await selectRows("sds_documents", `select=id,product_name,trade_name,document_language,revision_date,status&id=eq.${document.language_variant_of}&limit=1`);
    if (rows.length) info.suggested_candidate = rows[0];
  }
  if (document.sds_record_id) {
    const [records, variants] = await Promise.all([
      selectRows("sds_records", `select=*&id=eq.${document.sds_record_id}&limit=1`),
      selectRows("sds_documents", `select=id,product_name,trade_name,document_language,revision_date,status,approved_for_employee_view&sds_record_id=eq.${document.sds_record_id}&deleted_at=is.null&order=document_language.asc&limit=20`)
    ]);
    info.record = records[0] || null;
    info.linked_variants = variants;
  }
  return info;
}

// Group this document with a sibling as a language variant of one canonical product record.
async function groupDocument(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const existing = await fetchDocument(id);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.deleted_at || existing.archived_at) return json({ error: "Restore this record before grouping it." }, 409, cors);
  const siblingId = String(body.link_to_document_id || existing.language_variant_of || "");
  if (!UUID_PATTERN.test(siblingId)) return json({ error: "A document to link with is required." }, 400, cors);
  if (siblingId === id) return json({ error: "A document cannot be grouped with itself." }, 400, cors);
  const sibling = await fetchDocument(siblingId);
  if (!sibling) return json({ error: "The document to link with was not found." }, 404, cors);

  let recordId: string | null = sibling.sds_record_id || existing.sds_record_id || null;
  if (!recordId) {
    const canonicalName = existing.product_name || sibling.product_name || existing.trade_name || sibling.trade_name || "Unnamed product";
    const inserted = await insertRows("sds_records", {
      canonical_product_name: canonicalName,
      normalized_product_name: normalizeProductName(canonicalName),
      supplier_or_manufacturer: existing.supplier || existing.manufacturer || sibling.supplier || sibling.manufacturer || null
    });
    recordId = (Array.isArray(inserted) ? inserted[0]?.id : (inserted as any)?.id) || null;
  }
  if (!recordId) return json({ error: "Could not create or resolve the product record." }, 500, cors);

  const now = nowIso();
  await updateRows("sds_documents", `id=eq.${id}`, {
    sds_record_id: recordId, language_variant_of: siblingId, language_variant_status: "linked", updated_at: now, version: existing.version + 1
  }, false);
  if (!sibling.sds_record_id) {
    await updateRows("sds_documents", `id=eq.${siblingId}`, {
      sds_record_id: recordId, language_variant_status: "linked", updated_at: now, version: sibling.version + 1
    }, false);
  }
  const updated = await fetchDocument(id);
  await history(id, "GROUP_LANGUAGE_VARIANT", existing.status, updated?.status || existing.status, actor, { sds_record_id: recordId, linked_to: siblingId }, body.comment);
  await auditEvent(actor, "GROUP_LANGUAGE_VARIANT", updated, body.comment, existing, updated);
  return json({ document: updated, group: await buildVariantInfo(updated || existing) }, 200, cors);
}

// Keep this document separate (not a language variant of the suggested sibling).
async function ungroupDocument(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const existing = await fetchDocument(id);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  const now = nowIso();
  await updateRows("sds_documents", `id=eq.${id}`, {
    sds_record_id: null, language_variant_of: null, language_variant_status: "separate", updated_at: now, version: existing.version + 1
  }, false);
  const updated = await fetchDocument(id);
  await history(id, "SEPARATE_LANGUAGE_VARIANT", existing.status, updated?.status || existing.status, actor, { previous_record: existing.sds_record_id || null }, body.comment);
  await auditEvent(actor, "SEPARATE_LANGUAGE_VARIANT", updated, body.comment, existing, updated);
  return json({ document: updated, group: await buildVariantInfo(updated || existing) }, 200, cors);
}

async function saveReview(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const existing = await fetchDocument(id);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.deleted_at || existing.archived_at) return json({ error: "Restore this record before editing it." }, 409, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "This record is already approved. Explicit overwrite confirmation is required." }, 409, cors);
  let metadata: Extraction;
  try { metadata = pickEditableMetadata({ ...metadataFromRow(existing), ...(body.metadata || {}) }); }
  catch (error) { return json({ error: "Review metadata is invalid.", details: (error as any)?.issues || [] }, 400, cors); }
  const dateBefore = dateAuditSnapshot(existing);
  const dateAfter = dateAuditSnapshot(metadata as unknown as Record<string, unknown>);
  const dateChanged = JSON.stringify(dateBefore) !== JSON.stringify(dateAfter);
  if (dateChanged && actor.role !== "EHS_ADMIN") return json({ error: "Role does not allow this action. Only EHS_ADMIN can correct SDS dates." }, 403, cors);
  if (dateChanged && !cleanComment(body.comment)) return json({ error: "A reason/comment is required for date correction." }, 400, cors);
  const nextStatus = existing.status === "Approved" ? "Needs Review" : existing.status;
  await updateRows("sds_documents", `id=eq.${id}`, { ...metadataColumns(metadata), status: nextStatus, updated_at: nowIso(), version: existing.version + 1 }, false);
  const updated = await fetchDocument(id);
  await history(id, "SAVE_REVIEW_EDITS", existing.status, nextStatus, actor, body.metadata || {}, body.comment);
  await auditEvent(actor, "SAVE_REVIEW_EDITS", updated, body.comment, existing, updated);
  if (dateChanged) await auditEvent(actor, "DATE_CORRECTION", updated, body.comment, dateBefore, dateAuditSnapshot(updated || {}));
  return json({ document: updated }, 200, cors);
}

async function reextract(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const existing = await fetchDocument(id);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.deleted_at || existing.archived_at) return json({ error: "Restore this record before requesting re-extraction." }, 409, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Re-extracting an approved record requires explicit confirmation." }, 409, cors);
  await auditEvent(actor, "REQUEST_REEXTRACTION", existing, body.comment, existing, { force_gemini: Boolean(body.forceGemini) });
  await runExtraction(id, null, actor, Boolean(body.forceGemini));
  return json({ document: await fetchDocument(id) }, 200, cors);
}

async function approve(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const existing = await fetchDocument(id);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.deleted_at || existing.archived_at) return json({ error: "Restore this record before approval." }, 409, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Record is already approved. Explicit overwrite confirmation is required." }, 409, cors);
  let metadata: Extraction;
  try { metadata = pickEditableMetadata({ ...metadataFromRow(existing), ...(body.metadata || {}) }); }
  catch (error) { return json({ error: "Approval metadata is invalid.", details: (error as any)?.issues || [] }, 400, cors); }
  if (!metadata.product_name && !metadata.trade_name) return json({ error: "Product name or trade name is required for approval." }, 400, cors);
  const dateBefore = dateAuditSnapshot(existing);
  const dateAfter = dateAuditSnapshot(metadata as unknown as Record<string, unknown>);
  const dateChanged = JSON.stringify(dateBefore) !== JSON.stringify(dateAfter);
  if (dateChanged && !cleanComment(body.comment)) return json({ error: "A reason/comment is required for date correction." }, 400, cors);
  if (metadata.validity_date_basis === "print_date" && !body.confirmPrintDate) return json({ error: "Print date is the only validity basis. EHS confirmation is required before approval.", requires_print_date_confirmation: true }, 409, cors);
  const baseFilename = generateApprovedFilename(metadata as unknown as Record<string, unknown>);
  let filename = baseFilename;
  const collisions = await selectRows("sds_documents", `select=id,product_name,trade_name,revision_date,file_sha256,approved_filename,approved_download_url&approved_filename=eq.${encodeURIComponent(baseFilename)}&status=eq.Approved&id=neq.${id}&limit=5`);
  if (collisions.length) {
    const identical = collisions.find((row: Record<string, unknown>) => row.file_sha256 && row.file_sha256 === existing.file_sha256) as Record<string, unknown> | undefined;
    // An exact byte-identical SDS is already approved: never create a second approved copy. Surface a clear choice to EHS.
    if (identical && !body.confirmNewRevision) {
      return json({
        error: "This SDS appears to already exist. You can use the existing approved SDS, mark this as duplicate, or upload it as a new revision.",
        code: "DUPLICATE_APPROVED",
        duplicate_kind: "identical",
        existing: { id: identical.id, product_name: identical.product_name || identical.trade_name || "Approved SDS", revision_date: identical.revision_date || null, approved_filename: identical.approved_filename || null, pdf_url: identical.approved_download_url || null },
        proposed_filename: baseFilename
      }, 409, cors);
    }
    // Same controlled name but different content (or an explicit new revision): assign a unique, safe filename. Existing approved files are never overwritten.
    filename = await uniqueApprovedFilename(baseFilename, id);
  }
  const bytes = await downloadPrivateAsset(Number(existing.original_asset_id));
  const asset = await uploadApproved(id, filename, bytes);
  const approvedAt = nowIso();
  await updateRows("sds_documents", `id=eq.${id}`, {
    ...metadataColumns(metadata),
    status: "Approved",
    approved_filename: filename,
    approved_storage_key: asset.assetName,
    approved_asset_id: asset.assetId,
    approved_download_url: asset.downloadUrl,
    approved_at: approvedAt,
    approved_by: actor.displayName,
    approved_for_employee_view: true,
    updated_at: approvedAt,
    version: existing.version + 1
  }, false);
  const approved = await fetchDocument(id);
  await history(id, "APPROVE", existing.status, "Approved", actor, { approved_filename: filename, metadata }, body.comment);
  await auditEvent(actor, "APPROVE", approved, body.comment, existing, approved);
  if (dateChanged) await auditEvent(actor, "DATE_CORRECTION", approved, body.comment, dateBefore, dateAuditSnapshot(approved || {}));
  return json({ document: approved, approved_filename: filename }, 200, cors);
}

// Never overwrite an existing approved asset: derive the next free "..._r2.pdf", "..._r3.pdf" name.
async function uniqueApprovedFilename(base: string, selfId: string) {
  const stem = base.replace(/\.pdf$/i, "");
  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${stem}_r${suffix}.pdf`;
    const taken = await selectRows("sds_documents", `select=id&approved_filename=eq.${encodeURIComponent(candidate)}&status=eq.Approved&id=neq.${selfId}&limit=1`);
    if (!taken.length) return candidate;
  }
  return `${stem}_${Date.now()}.pdf`;
}

async function changeStatus(id: string, target: string, action: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const existing = await fetchDocument(id);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.deleted_at || (existing.archived_at && target !== "Archived")) return json({ error: "Restore this record before changing its status." }, 409, cors);
  if (target === "Archived" && existing.archived_at) return json({ error: "Record is already archived." }, 409, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Changing an approved record requires explicit confirmation." }, 409, cors);
  const changes: Record<string, unknown> = { status: target, updated_at: nowIso(), version: existing.version + 1 };
  if (target === "Rejected") changes.rejected_at = nowIso();
  if (target === "Archived") { changes.archived_at = nowIso(); changes.archived_by = actor.userId; changes.archive_reason = cleanComment(body.comment); }
  await updateRows("sds_documents", `id=eq.${id}`, changes, false);
  const updated = await fetchDocument(id);
  await history(id, action, existing.status, target, actor, null, body.comment);
  await auditEvent(actor, action, updated, body.comment, existing, updated);
  return json({ document: updated }, 200, cors);
}

async function markDuplicate(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  if (!UUID_PATTERN.test(String(body.duplicate_of_id || ""))) return json({ error: "A valid duplicate_of_id is required." }, 400, cors);
  if (body.duplicate_of_id === id) return json({ error: "A record cannot duplicate itself." }, 400, cors);
  const [existing, target] = await Promise.all([fetchDocument(id), fetchDocument(body.duplicate_of_id)]);
  if (!existing || !target) return json({ error: "Document or duplicate target was not found." }, 404, cors);
  if (existing.deleted_at || existing.archived_at || target.deleted_at || target.archived_at) return json({ error: "Deleted or archived records cannot be used for duplicate control until restored." }, 409, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Marking an approved record as duplicate requires confirmation." }, 409, cors);
  await updateRows("sds_documents", `id=eq.${id}`, { status: "Duplicate", possible_duplicate_flag: true, duplicate_of_id: body.duplicate_of_id, updated_at: nowIso(), version: existing.version + 1 }, false);
  const updated = await fetchDocument(id);
  await history(id, "MARK_DUPLICATE", existing.status, "Duplicate", actor, { duplicate_of_id: body.duplicate_of_id }, body.comment);
  await auditEvent(actor, "MARK_DUPLICATE", updated, body.comment, existing, updated);
  return json({ document: updated }, 200, cors);
}

async function bulkAction(action: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => UUID_PATTERN.test(id)))].slice(0, 200);
  const reason = cleanComment(body.reason);
  const expected = action === "archive" ? "ARCHIVE" : action === "delete" ? "DELETE" : action === "restore" ? "RESTORE" : "PURGE";
  if (!ids.length) return json({ error: "Select at least one valid SDS record." }, 400, cors);
  if (String(body.confirmation || "").trim() !== expected) return json({ error: `Type ${expected} to confirm this bulk action.` }, 400, cors);
  if (!reason) return json({ error: "A reason/comment is required." }, 400, cors);

  const results: Record<string, unknown>[] = [];
  let succeeded = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      const existing = await fetchDocument(id);
      if (!existing) { skipped += 1; results.push({ id, status: "skipped", reason: "Document not found" }); continue; }
      if (action === "purge") {
        // Permanent removal, no soft-delete: clear inbound duplicate references, delete stored assets, then hard-delete the row.
        await updateRows("sds_documents", `duplicate_of_id=eq.${id}`, { duplicate_of_id: null }, false).catch(() => {});
        await deleteReleaseAssetSafe(existing.original_asset_id);
        await deleteReleaseAssetSafe(existing.approved_asset_id);
        await auditEvent(actor, "PURGE", existing, reason, existing, null);
        await deleteRows("sds_documents", `id=eq.${id}`);
        succeeded += 1;
        results.push({ id, product_name: existing.product_name || existing.trade_name || null, status: "success" });
        continue;
      }
      if (action === "archive" && (existing.archived_at || existing.deleted_at)) { skipped += 1; results.push({ id, status: "skipped", reason: existing.deleted_at ? "Document is deleted" : "Already archived" }); continue; }
      if (action === "delete" && existing.deleted_at) { skipped += 1; results.push({ id, status: "skipped", reason: "Already deleted" }); continue; }
      if (action === "restore" && !existing.deleted_at && !existing.archived_at) { skipped += 1; results.push({ id, status: "skipped", reason: "Document is already active" }); continue; }

      const now = nowIso();
      let changes: Record<string, unknown>;
      if (action === "archive") changes = { status: "Archived", archived_at: now, archived_by: actor.userId, archive_reason: reason, updated_at: now, version: existing.version + 1 };
      else if (action === "delete") changes = { deleted_at: now, deleted_by: actor.userId, delete_reason: reason, updated_at: now, version: existing.version + 1 };
      else changes = { deleted_at: null, deleted_by: null, delete_reason: null, archived_at: null, archived_by: null, archive_reason: null, status: existing.status === "Archived" ? "Needs Review" : existing.status, updated_at: now, version: existing.version + 1 };
      await updateRows("sds_documents", `id=eq.${id}`, changes, false);
      const updated = await fetchDocument(id);
      const auditAction = action === "archive" ? "BULK_ARCHIVE" : action === "delete" ? "BULK_DELETE" : "RESTORE";
      await history(id, auditAction, existing.status, String(updated?.status || existing.status), actor, changes, reason);
      await auditEvent(actor, auditAction, updated, reason, existing, updated);
      succeeded += 1;
      results.push({ id, product_name: updated?.product_name || updated?.trade_name || null, status: "success" });
    } catch (error) {
      failed += 1;
      results.push({ id, status: "failed", reason: safeError(error) });
    }
  }
  await auditEvent(actor, action === "purge" ? "BULK_PURGE" : action === "archive" ? "BULK_ARCHIVE" : action === "delete" ? "BULK_DELETE" : "RESTORE", null, reason, null, { ids, succeeded, skipped, failed });
  return json({ total_selected: ids.length, succeeded, skipped, failed, results }, 200, cors);
}

// Best-effort removal of a stored GitHub release asset; a missing/forbidden asset must not block the purge.
async function deleteReleaseAssetSafe(assetId: unknown) {
  const id = Number(assetId);
  if (!id) return;
  try { await deleteReleaseAsset(id); } catch (error) { console.warn("Release asset delete skipped:", safeError(error)); }
}

async function restoreDocument(id: string, request: Request, cors: Record<string, string> | null, actor: Actor) {
  const body = await readJson(request);
  body.ids = [id];
  body.confirmation = "RESTORE";
  const forwarded = new Request(request.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return bulkAction("restore", forwarded, cors, actor);
}

async function dashboard(cors: Record<string, string> | null) {
  const rows = await selectRows("sds_documents", "select=id,original_filename,product_name,trade_name,status,extraction_confidence,updated_at&deleted_at=is.null&order=updated_at.desc&limit=1000");
  const counts = Object.fromEntries(SDS_STATUSES.map((status) => [status, rows.filter((row: Record<string, unknown>) => row.status === status).length]));
  const overdue = Date.now() - 7 * 86400000;
  return json({
    counts,
    overdue_review_count: rows.filter((row: Record<string, unknown>) => row.status === "Needs Review" && new Date(String(row.updated_at)).getTime() < overdue).length,
    recent: rows.slice(0, 10)
  }, 200, cors);
}

async function duplicateList(cors: Record<string, string> | null) {
  const rows = await selectRows("sds_documents", "select=id,original_filename,product_name,trade_name,revision_date,status,file_sha256,possible_duplicate_flag,duplicate_of_id,updated_at&deleted_at=is.null&archived_at=is.null&order=updated_at.desc&limit=1000");
  const hashes = new Map<string, number>();
  for (const row of rows) hashes.set(row.file_sha256, (hashes.get(row.file_sha256) || 0) + 1);
  return json({ documents: rows.filter((row: Record<string, unknown>) => row.possible_duplicate_flag || (hashes.get(String(row.file_sha256)) || 0) > 1) }, 200, cors);
}

async function publicCatalog(cors: Record<string, string> | null) {
  // Only Approved rows are published, so per-language approval is already enforced: a pending or
  // rejected language variant simply is not returned and stays hidden from employees.
  const rows = await selectRows("sds_documents", "select=id,approved_filename,approved_download_url,product_name,trade_name,supplier,manufacturer,language,document_language,is_bilingual,sds_record_id,revision_date,established_date,expiry_date,signal_word,hazard_statements,recommended_use,updated_at&status=eq.Approved&deleted_at=is.null&archived_at=is.null&order=product_name.asc.nullslast,trade_name.asc");
  return json({
    schemaVersion: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    documents: rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.product_name || row.trade_name,
      file: row.approved_filename,
      pdfUrl: row.approved_download_url,
      department: "Unassigned",
      revisionDate: /^\d{4}-\d{2}-\d{2}$/.test(String(row.revision_date || "")) ? row.revision_date : "",
      establishedDate: /^\d{4}-\d{2}-\d{2}$/.test(String(row.established_date || "")) ? row.established_date : "",
      expiryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(row.expiry_date || "")) ? row.expiry_date : "",
      documentType: "SDS",
      manufacturer: row.manufacturer || row.supplier || "",
      language: row.language || "",
      documentLanguage: row.document_language || "unknown",
      isBilingual: Boolean(row.is_bilingual),
      groupId: row.sds_record_id || null,
      hazards: Array.isArray(row.hazard_statements) ? row.hazard_statements.slice(0, 6) : [],
      signalWord: row.signal_word || "",
      recommendedUse: row.recommended_use || ""
    }))
  }, 200, cors);
}

// Public, CORS-enabled PDF proxy for the inline preview. GitHub release assets do not send CORS
// headers, so a browser cannot byte-fetch them for PDF.js; we fetch the approved SDS server-side and
// re-serve it same-origin with CORS. "Open official SDS PDF" still uses the direct GitHub link.
async function streamCatalogFile(url: URL, cors: Record<string, string> | null) {
  if (!cors) return json({ error: "Origin is not allowed." }, 403);
  const chemicalId = String(url.searchParams.get("id") || "").trim();
  if (!UUID_PATTERN.test(chemicalId) && !STATIC_ID_PATTERN.test(chemicalId)) return json({ error: "A valid document id is required." }, 400, cors);
  const resolved = await resolveSdsForAsk(chemicalId);
  if (!resolved) return json({ error: "Approved SDS not found." }, 404, cors);
  let bytes: Uint8Array;
  try {
    bytes = await fetchAskPdf(resolved.pdfUrl, PREVIEW_PDF_MAX_BYTES);
  } catch (error) {
    console.error("Catalog PDF proxy failed", safeError(error));
    return json({ error: "The official SDS PDF is temporarily unavailable. Open it directly instead." }, 502, cors);
  }
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(bytes as BodyInit, { headers });
}

// Public, grounded Q&A for end users. Answers only from the selected official SDS.
async function askQuestion(request: Request, cors: Record<string, string> | null) {
  if (!cors) return json({ error: "Origin is not allowed." }, 403);
  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  if (!geminiKey) return json({ error: "AI assistance is not configured." }, 503, cors);

  const body = await readJson(request);
  const chemicalId = String(body.chemicalId || "").trim();
  const question = String(body.question || "").trim();
  if (question.length < 3 || question.length > 500) return json({ error: "Ask a question between 3 and 500 characters." }, 400, cors);
  if (!UUID_PATTERN.test(chemicalId) && !STATIC_ID_PATTERN.test(chemicalId)) return json({ error: "A valid document id is required." }, 400, cors);

  if (!(await askRateAllowed(request))) {
    return json({ error: "Question limit reached. Open the official SDS and try again shortly." }, 429, { ...cors, "Retry-After": "60" });
  }

  let resolved: { name: string; pdfUrl: string; revisionDate: string } | null;
  try {
    resolved = await resolveSdsForAsk(chemicalId);
  } catch (error) {
    console.error("Ask resolve failed", safeError(error));
    return json({ error: "The selected SDS could not be located." }, 502, cors);
  }
  if (!resolved) return json({ error: "AI assistance is available only for approved SDS documents in the catalog." }, 404, cors);

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await fetchAskPdf(resolved.pdfUrl);
  } catch (error) {
    console.error("Ask PDF fetch failed", safeError(error));
    return json({ error: "The official SDS PDF is temporarily unavailable. Open it directly for the answer." }, 502, cors);
  }

  try {
    const answer = await answerFromSds(geminiKey, resolved, question, pdfBytes);
    return json({ answer, chemicalId, revisionDate: resolved.revisionDate }, 200, cors);
  } catch (error) {
    console.error("Ask Gemini failed", safeError(error));
    return json({ error: "AI assistance is unavailable. Open the official SDS for authoritative information." }, 502, cors);
  }
}

async function resolveSdsForAsk(chemicalId: string) {
  if (UUID_PATTERN.test(chemicalId)) {
    const rows = await selectRows("sds_documents", `select=product_name,trade_name,revision_date,approved_download_url,status&id=eq.${chemicalId}&status=eq.Approved&deleted_at=is.null&archived_at=is.null&limit=1`);
    const doc = rows[0];
    if (!doc || !doc.approved_download_url) return null;
    return {
      name: String(doc.product_name || doc.trade_name || "the selected product").slice(0, 200),
      pdfUrl: String(doc.approved_download_url),
      revisionDate: /^\d{4}-\d{2}-\d{2}$/.test(String(doc.revision_date || "")) ? String(doc.revision_date) : ""
    };
  }
  const documents = await loadStaticCatalog();
  const doc = documents.find((item) => item?.id === chemicalId);
  if (!doc) return null;
  if (String(doc.documentType || "SDS") !== "SDS") return null;
  const file = String(doc.file || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._,'-]{0,190}\.pdf$/.test(file)) return null;
  const explicitUrl = typeof doc.pdfUrl === "string" && /^https:\/\//.test(doc.pdfUrl) ? doc.pdfUrl : "";
  return {
    name: String(doc.name || "the selected product").slice(0, 200),
    pdfUrl: explicitUrl || `${pagesBaseUrl()}pdfs/${file}`,
    revisionDate: /^\d{4}-\d{2}-\d{2}$/.test(String(doc.revisionDate || "")) ? String(doc.revisionDate) : ""
  };
}

async function loadStaticCatalog(): Promise<Record<string, unknown>[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < 60000) return catalogCache.documents;
  const response = await fetch(`${pagesBaseUrl()}data/sds-data.json`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Static catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  const documents = payload?.schemaVersion === 1 && Array.isArray(payload.documents) ? payload.documents : [];
  catalogCache = { fetchedAt: Date.now(), documents };
  return documents;
}

async function fetchAskPdf(pdfUrl: string, maxBytes = ASK_PDF_MAX_BYTES) {
  const parsed = new URL(pdfUrl);
  const allowedHosts = new Set([
    new URL(pagesBaseUrl()).host, "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"
  ]);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.host)) throw new Error("Disallowed SDS PDF location");
  const response = await fetch(pdfUrl, { headers: { Accept: "application/pdf" }, redirect: "follow" });
  if (!response.ok) throw new Error(`SDS PDF returned HTTP ${response.status}`);
  if (Number(response.headers.get("Content-Length") || 0) > maxBytes) throw new Error("SDS PDF exceeds the size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("SDS PDF exceeds the size limit");
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("Approved file is not a valid PDF");
  return bytes;
}

async function answerFromSds(apiKey: string, resolved: { name: string; revisionDate: string }, question: string, pdfBytes: Uint8Array) {
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASK_GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: "You are a document-grounded workplace safety assistant. Answer ONLY from the attached official Safety Data Sheet. If the answer is not in this SDS, say you cannot determine it from this document and point the worker to the relevant SDS section and the site safety manager. Never invent exposure limits, PPE, first-aid steps, incompatibilities, or disposal steps. Never override the SDS, the site emergency plan, emergency services, poison control, or medical professionals. Reply in the same language as the worker's question. Use concise plain-text bullets and name the SDS section numbers you used." }] },
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: "application/pdf", data: askBytesToBase64(pdfBytes) } },
          { text: `Product: ${resolved.name}\nSDS revision: ${resolved.revisionDate || "Not stated"}\nWorker question: ${question}` }
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 800 }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
    const payload = await response.json();
    const answer = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text).filter((text: unknown) => typeof text === "string").join("\n").trim();
    if (!answer) throw new Error("Gemini returned no answer");
    return `Supplemental AI summary — verify against the official SDS:\n\n${answer}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function askRateAllowed(request: Request) {
  const ipHash = await hashClientIp(request);
  const since = new Date(Date.now() - ASK_RATE_WINDOW_MS).toISOString();
  try {
    const rows = await selectRows("sds_ask_usage", `select=id&ip_hash=eq.${ipHash}&created_at=gte.${encodeURIComponent(since)}`);
    if ((rows?.length || 0) >= ASK_RATE_LIMIT) return false;
    await insertRows("sds_ask_usage", { ip_hash: ipHash }, false);
    return true;
  } catch (error) {
    // Fail open: never block access to safety information because the rate-limit table is missing or unreachable.
    console.warn("Ask rate-limit check skipped", safeError(error));
    return true;
  }
}

async function hashClientIp(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
  const salt = Deno.env.get("ADMIN_API_TOKEN") || "sds-ask";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pagesBaseUrl() {
  const repository = Deno.env.get("GITHUB_REPOSITORY") || "tamco-ehs/sds-hub";
  const [owner, name] = repository.split("/");
  return `https://${owner}.github.io/${name}/`;
}

function askBytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function streamFile(id: string, variant: string, admin: boolean, cors: Record<string, string> | null, actor: Actor | null = null) {
  const document = await fetchDocument(id);
  if (!document || (!admin && (document.status !== "Approved" || document.deleted_at || document.archived_at))) return json({ error: "Approved document not found." }, 404, cors);
  if (admin && (document.deleted_at || document.archived_at) && actor?.role !== "EHS_ADMIN") return json({ error: "Role does not allow access to archived or deleted SDS records." }, 403, cors);
  if (!admin || variant === "approved") {
    if (!document.approved_download_url) return json({ error: "Approved file is unavailable." }, 404, cors);
    return Response.redirect(document.approved_download_url, 302);
  }
  const bytes = await downloadPrivateAsset(Number(document.original_asset_id));
  const headers = new Headers(cors || {});
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.original_filename)}`);
  headers.set("Cache-Control", "no-store");
  return new Response(bytes, { headers });
}

async function fetchDocument(id: string): Promise<Record<string, any> | null> {
  const rows = await selectRows("sds_documents", `select=*&id=eq.${id}&limit=1`);
  return rows[0] || null;
}

function metadataFromRow(row: Record<string, unknown>) {
  const metadata = emptyExtraction() as unknown as Record<string, unknown>;
  for (const key of Object.keys(metadata)) metadata[key] = row[key] ?? metadata[key];
  return extractionSchema.parse(metadata);
}

function metadataColumns(metadata: Extraction) {
  const derivedBasis = metadata.validity_date_basis
    || (metadata.revision_date ? "revision_date" : metadata.issue_date ? "issue_date" : metadata.preparation_date ? "preparation_date" : metadata.establishment_date ? "establishment_date" : metadata.effective_date ? "effective_date" : metadata.print_date ? "print_date" : null);
  const validityValue = derivedBasis ? metadata[derivedBasis] : metadata.validity_date_value;
  const validity = computeValidity(validityValue, null);
  return {
    is_likely_sds: metadata.is_likely_sds,
    product_name: metadata.product_name,
    trade_name: metadata.trade_name,
    supplier: metadata.supplier,
    manufacturer: metadata.manufacturer,
    language: metadata.language,
    issue_date: metadata.issue_date,
    revision_date: metadata.revision_date,
    preparation_date: metadata.preparation_date,
    print_date: metadata.print_date,
    effective_date: metadata.effective_date,
    establishment_date: metadata.establishment_date,
    supersedes_date: metadata.supersedes_date,
    detected_date_source: metadata.detected_date_source,
    detected_date_confidence: Math.round(metadata.detected_date_confidence),
    validity_date_basis: derivedBasis,
    validity_date_value: validity.establishedDate,
    date_detection_warnings: metadata.date_detection_warnings,
    established_date: validity.establishedDate,
    expiry_date: validity.expiryDate,
    cas_numbers: metadata.cas_numbers,
    signal_word: metadata.signal_word,
    ghs_pictograms: metadata.ghs_pictograms,
    hazard_statements: metadata.hazard_statements,
    precautionary_statements: metadata.precautionary_statements,
    recommended_use: metadata.recommended_use,
    ppe_recommendation: metadata.ppe_recommendation,
    storage_summary: metadata.storage_summary,
    first_aid_summary: metadata.first_aid_summary,
    spill_response_summary: metadata.spill_response_summary,
    firefighting_summary: metadata.firefighting_summary,
    disposal_summary: metadata.disposal_summary,
    extraction_confidence: Math.round(metadata.extraction_confidence),
    missing_fields: metadata.missing_fields,
    possible_duplicate_flag: metadata.possible_duplicate_flag,
    review_required_reason: metadata.review_required_reason
  };
}

async function extractionLog(documentId: string, stage: string, method: string, status: string, model: string | null, confidence: number, keywordHits: string[], response: unknown, errorMessage: string | null, textLength: number) {
  await insertRows("sds_extraction_logs", {
    document_id: documentId, stage, method, status, model, confidence, text_length: textLength,
    keyword_hits: keywordHits, response_json: response, error_message: errorMessage || null
  }, false);
}

async function history(documentId: string, action: string, fromStatus: string | null, toStatus: string | null, actor: Actor, changes: unknown, comment: unknown) {
  await insertRows("sds_review_history", {
    document_id: documentId, action, from_status: fromStatus, to_status: toStatus,
    reviewer: actor.displayName, actor_user_id: actor.userId, reviewer_role: actor.role, changes_json: changes,
    comment: comment ? String(comment).slice(0, 2000) : null
  }, false);
}

async function auditEvent(actor: Actor, action: string, document: Record<string, any> | null, reason: unknown, before: unknown, after: unknown, batchId: string | null = null) {
  await insertRows("sds_audit_events", {
    document_id: document?.id || null,
    batch_id: batchId,
    action,
    product_name: document?.product_name || document?.trade_name || null,
    original_filename: document?.original_filename || null,
    actor_user_id: actor.userId,
    display_name: actor.displayName,
    role: actor.role,
    reason: cleanComment(reason),
    before_json: before ?? null,
    after_json: after ?? null
  }, false);
}

async function authenticate(request: Request): Promise<Actor> {
  const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!provided) throw new ApiProblem("Not logged in.", 401);

  const emergency = Deno.env.get("ADMIN_API_TOKEN") || "";
  if (emergency && await safeTokenEqual(provided, emergency)) {
    return { userId: null, displayName: "Emergency Administrator", role: "EHS_ADMIN", email: null, emergency: true };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !anonKey) throw new ApiProblem("Supabase Auth configuration is unavailable.", 500);
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${provided}`, Accept: "application/json" }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ApiProblem("Session expired. Please log in again.", 401);
    throw new ApiProblem("Supabase Auth could not validate this session.", 502);
  }
  const user = await response.json();
  if (!user?.id || !UUID_PATTERN.test(String(user.id))) throw new ApiProblem("Session expired. Please log in again.", 401);
  const profiles = await selectRows("admin_users", `select=id,display_name,role,is_active&id=eq.${user.id}&limit=1`);
  const profile = profiles[0];
  if (!profile) throw new ApiProblem("User not authorized for EHS admin.", 403);
  if (!profile.is_active) throw new ApiProblem("Account inactive.", 403);
  if (!["EHS_ADMIN", "EHS_REVIEWER"].includes(String(profile.role))) throw new ApiProblem("User not authorized for EHS admin.", 403);
  return { userId: String(user.id), displayName: cleanReviewer(profile.display_name) || String(user.email || "EHS user"), role: profile.role as EhsRole, email: String(user.email || "") || null, emergency: false };
}

function requireRole(actor: Actor, role: EhsRole) {
  if (actor.role !== role) throw new ApiProblem("Role does not allow this action.", 403);
  return actor;
}

function publicActor(actor: Actor) {
  return { id: actor.userId, email: actor.email, display_name: actor.displayName, role: actor.role, emergency: actor.emergency };
}

async function safeTokenEqual(leftToken: string, rightToken: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(leftToken)), crypto.subtle.digest("SHA-256", encoder.encode(rightToken))
  ]);
  const left = new Uint8Array(leftHash), right = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function dateAuditSnapshot(value: Record<string, unknown>) {
  const keys = ["revision_date","issue_date","preparation_date","establishment_date","effective_date","print_date","validity_date_basis","validity_date_value"];
  return Object.fromEntries(keys.map((key) => [key, value?.[key] ?? null]));
}

function apiPath(pathname: string) {
  const marker = "/sds-api";
  const index = pathname.lastIndexOf(marker);
  return index >= 0 ? pathname.slice(index + marker.length) || "/" : pathname;
}

function corsHeaders(request: Request): Record<string, string> | null {
  const origin = request.headers.get("Origin");
  const allowed = (Deno.env.get("ALLOWED_ORIGIN") || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin) return {};
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function json(payload: unknown, status = 200, extraHeaders: Record<string, string> | null = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...(extraHeaders || {})
    }
  });
}

function cleanReviewer(value: unknown) { return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 100); }
function cleanComment(value: unknown) { return String(value || "").replace(/[\r\t]+/g, " ").trim().slice(0, 2000) || null; }
async function readJson(request: Request): Promise<Record<string, any>> { try { return await request.json(); } catch { return {}; } }
function safeError(error: unknown) { return String((error as Error)?.message || error || "Unknown error").replace(/[\r\n\t]+/g, " ").slice(0, 500); }
// Reviewer-facing wording for AI fallback failures. The raw provider error is still kept in sds_extraction_logs.
function friendlyExtractionNote(geminiError: string, ocrRequired: boolean) {
  const quota = /\b429\b|quota|rate.?limit|resource.?exhausted/i.test(geminiError);
  const timeout = /abort|timeout|timed out/i.test(geminiError);
  if (ocrRequired) {
    // Text was weak/scanned, so AI/OCR was genuinely needed — this one does warrant manual checking.
    return quota
      ? "AI/OCR assistance was temporarily unavailable (quota limit); this scanned or low-text PDF needs manual verification."
      : "AI/OCR assistance unavailable; this scanned or low-text PDF needs manual verification.";
  }
  // Readable PDF: rule-based extraction stands on its own; the AI gap is informational, not a failure.
  if (quota) return "AI assistance was temporarily unavailable (quota limit); rule-based extraction was used.";
  if (timeout) return "AI assistance unavailable (timed out); rule-based extraction was used.";
  return "AI assistance unavailable; rule-based extraction was used.";
}

function geminiVerificationStatus(needed: boolean, key: string, result: Extraction | null, error: string, allowed: boolean) {
  if (result) return "verified";
  if (!allowed && !needed) return "disabled_for_batch";
  if (!needed) return "skipped_rule_clear";
  if (!key) return "not_configured";
  if (/\b429\b|quota|rate.?limit|resource.?exhausted/i.test(error)) return "quota_exceeded";
  if (/abort|timeout|timed out/i.test(error)) return "timeout";
  return error ? "error" : "not_run";
}
