import { assessSdsText, extractFirstTwoPages, extractWithGemini, extractWithRegex, mergeExtraction, shouldUseGemini } from "./extraction.js";
import { generateApprovedFilename, sha256Hex } from "./filename.js";
import { emptyExtraction, extractionSchema, parseJsonArray, pickEditableMetadata, SDS_STATUSES } from "./intake-schema.js";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_AUDIT_LENGTH = 50000;
const ADMIN_PREFIX = "/v1/admin";

export async function handleIntakeRequest(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    if (!cors) return responseJson({ error: "Origin is not allowed." }, 403);
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/v1/catalog" && request.method === "GET") {
    return publicCatalog(request, env, cors);
  }

  const publicFileMatch = url.pathname.match(/^\/v1\/documents\/([a-f0-9-]+)\/file$/i);
  if (publicFileMatch && request.method === "GET") {
    return streamDocumentFile(publicFileMatch[1], "approved", request, env, cors, false);
  }

  if (!url.pathname.startsWith(ADMIN_PREFIX)) return null;
  if (!await isAuthorized(request, env.ADMIN_API_TOKEN)) {
    return responseJson({ error: "Administrator authorization is required." }, 401, {
      ...cors,
      "WWW-Authenticate": "Bearer"
    });
  }

  const bindingError = validateBindings(env);
  if (bindingError) return responseJson({ error: bindingError }, 503, cors);

  if (url.pathname === `${ADMIN_PREFIX}/documents` && request.method === "POST") {
    return uploadDocument(request, env, cors);
  }
  if (url.pathname === `${ADMIN_PREFIX}/documents` && request.method === "GET") {
    return listDocuments(url, env, cors);
  }
  if (url.pathname === `${ADMIN_PREFIX}/dashboard` && request.method === "GET") {
    return dashboard(env, cors);
  }
  if (url.pathname === `${ADMIN_PREFIX}/duplicates` && request.method === "GET") {
    return duplicateList(env, cors);
  }

  const documentMatch = url.pathname.match(/^\/v1\/admin\/documents\/([a-f0-9-]+)(?:\/(extract|approve|reject|duplicate|archive|file))?$/i);
  if (!documentMatch) return responseJson({ error: "Admin endpoint not found." }, 404, cors);

  const [, documentId, action = ""] = documentMatch;
  if (!action && request.method === "GET") return getDocument(documentId, env, cors);
  if (!action && request.method === "PATCH") return saveReviewEdits(documentId, request, env, cors);
  if (action === "extract" && request.method === "POST") return reextractDocument(documentId, request, env, cors);
  if (action === "approve" && request.method === "POST") return approveDocument(documentId, request, env, cors);
  if (action === "reject" && request.method === "POST") return changeStatus(documentId, "Rejected", "Reject", request, env, cors);
  if (action === "archive" && request.method === "POST") return changeStatus(documentId, "Archived", "Archive", request, env, cors);
  if (action === "duplicate" && request.method === "POST") return markDuplicate(documentId, request, env, cors);
  if (action === "file" && request.method === "GET") {
    return streamDocumentFile(documentId, url.searchParams.get("variant") || "original", request, env, cors, true);
  }

  return responseJson({ error: "Method not allowed." }, 405, cors);
}

async function uploadDocument(request, env, cors) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) return responseJson({ error: "Upload exceeds the 15 MB limit." }, 413, cors);

  let form;
  try {
    form = await request.formData();
  } catch {
    return responseJson({ error: "Upload must use multipart/form-data." }, 400, cors);
  }

  const file = form.get("file");
  const reviewer = cleanReviewer(form.get("reviewer") || "Admin uploader");
  if (!(file instanceof File)) return responseJson({ error: "A PDF file is required." }, 400, cors);
  if (file.size < 5 || file.size > MAX_UPLOAD_BYTES) return responseJson({ error: "PDF must be between 5 bytes and 15 MB." }, 413, cors);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
    return responseJson({ error: "The uploaded file does not have a valid PDF signature." }, 400, cors);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const digest = await sha256Hex(bytes);
  const originalFilename = String(file.name || "uploaded-sds.pdf").slice(0, 255);
  const originalStorageKey = `original/${id}/source.pdf`;
  const duplicate = await env.DB.prepare(
    "SELECT id, product_name, status FROM sds_documents WHERE file_sha256 = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(digest).first();

  await env.SDS_FILES.put(originalStorageKey, bytes, {
    httpMetadata: { contentType: "application/pdf", contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(originalFilename)}` },
    customMetadata: { originalFilename, sha256: digest }
  });

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sds_documents (
        id, original_filename, original_storage_key, file_sha256, file_size, mime_type,
        status, possible_duplicate_flag, duplicate_of_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'application/pdf', 'Uploaded', ?, ?, ?, ?)
    `).bind(id, originalFilename, originalStorageKey, digest, file.size, duplicate ? 1 : 0, duplicate?.id || null, now, now),
    historyStatement(env, id, "Upload", null, "Uploaded", reviewer, { original_filename: originalFilename, sha256: digest }, duplicate ? "Exact file hash already exists." : null)
  ]);

  try {
    await runExtraction(id, env, { bytes, reviewer, forceGemini: false });
  } catch (error) {
    const reason = `Extraction failed: ${safeError(error)}`;
    await env.DB.batch([
      env.DB.prepare("UPDATE sds_documents SET status = 'Needs Review', review_required_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .bind(reason, new Date().toISOString(), id),
      extractionLogStatement(env, id, "Extraction", "pdf-text", "Error", null, 0, [], null, reason)
    ]);
  }

  const document = await fetchDocument(env, id);
  return responseJson({ document }, 201, cors);
}

async function runExtraction(documentId, env, { bytes = null, reviewer = "System extraction", forceGemini = false } = {}) {
  const document = await env.DB.prepare("SELECT * FROM sds_documents WHERE id = ?").bind(documentId).first();
  if (!document) throw new Error("Document not found");

  const fromStatus = document.status;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE sds_documents SET status = 'Parsing', updated_at = ?, version = version + 1 WHERE id = ?").bind(now, documentId),
    historyStatement(env, documentId, "Start extraction", fromStatus, "Parsing", reviewer, null, null)
  ]);

  let pdfBytes = bytes;
  if (!pdfBytes) {
    const object = await env.SDS_FILES.get(document.original_storage_key);
    if (!object) throw new Error("Original PDF is missing from storage");
    pdfBytes = new Uint8Array(await object.arrayBuffer());
  }

  let textResult = { text: "", pagesExtracted: 0, totalPages: 0 };
  let textError = null;
  try {
    textResult = await extractFirstTwoPages(pdfBytes);
  } catch (error) {
    textError = safeError(error);
  }

  const weakText = textResult.text.replace(/\s+/g, " ").trim().length < 300;
  const regexResult = extractWithRegex(textResult.text);
  let geminiResult = null;
  let geminiError = null;
  const useGemini = forceGemini || shouldUseGemini(regexResult, weakText, env);
  if (useGemini && env.GEMINI_API_KEY) {
    try {
      geminiResult = await extractWithGemini(pdfBytes, textResult.text, env);
    } catch (error) {
      geminiError = safeError(error);
    }
  }

  const productCandidate = regexResult.product_name || regexResult.trade_name || geminiResult?.product_name || geminiResult?.trade_name;
  const revisionCandidate = regexResult.revision_date || geminiResult?.revision_date || "";
  const metadataDuplicate = productCandidate
    ? await env.DB.prepare(`
        SELECT id FROM sds_documents
        WHERE id <> ? AND lower(COALESCE(product_name, trade_name, '')) = lower(?)
          AND COALESCE(revision_date, '') = ?
        ORDER BY created_at DESC LIMIT 1
      `).bind(documentId, productCandidate, revisionCandidate).first()
    : null;
  const duplicateOfId = document.duplicate_of_id || metadataDuplicate?.id || null;
  const isDuplicate = Boolean(duplicateOfId);
  const merged = mergeExtraction(regexResult, geminiResult, { ocrRequired: weakText || Boolean(textError), duplicate: isDuplicate });
  const method = geminiResult ? (weakText ? "pdf-text+gemini-ocr" : "pdf-text+regex+gemini") : "pdf-text+regex";
  if (geminiError) merged.review_required_reason = `${merged.review_required_reason}. Gemini fallback failed: ${geminiError}`;
  if (textError) merged.review_required_reason = `${merged.review_required_reason}. PDF text extraction failed: ${textError}`;

  const update = metadataUpdateStatement(env, documentId, merged, {
    status: "Extracted",
    ocrRequired: weakText || Boolean(textError),
    method,
    geminiUsed: Boolean(geminiResult),
    extractedText: textResult.text,
    duplicateOfId
  });
  const validation = assessSdsText(textResult.text);
  const completedAt = new Date().toISOString();
  await env.DB.batch([
    update,
    extractionLogStatement(
      env,
      documentId,
      "Extraction",
      method,
      geminiError ? "Completed with warning" : "Completed",
      env.GEMINI_MODEL || null,
      merged.extraction_confidence,
      validation.keywordHits,
      merged,
      geminiError || textError,
      textResult.text.length
    ),
    historyStatement(env, documentId, "Complete extraction", "Parsing", "Extracted", reviewer, { extraction_method: method }, null),
    env.DB.prepare("UPDATE sds_documents SET status = 'Needs Review', updated_at = ?, version = version + 1 WHERE id = ?")
      .bind(completedAt, documentId),
    historyStatement(env, documentId, "Route to EHS review", "Extracted", "Needs Review", reviewer, null, merged.review_required_reason)
  ]);
  return merged;
}

async function listDocuments(url, env, cors) {
  const status = url.searchParams.get("status");
  const query = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
  const conditions = [];
  const values = [];
  if (status && SDS_STATUSES.includes(status)) {
    conditions.push("status = ?");
    values.push(status);
  }
  if (query) {
    conditions.push("(lower(COALESCE(product_name, trade_name, original_filename)) LIKE lower(?) OR lower(original_filename) LIKE lower(?))");
    values.push(`%${query}%`, `%${query}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DB.prepare(`SELECT * FROM sds_documents ${where} ORDER BY updated_at DESC LIMIT ?`)
    .bind(...values, limit).all();
  return responseJson({ documents: result.results.map(rowToDocument) }, 200, cors);
}

async function getDocument(documentId, env, cors) {
  const document = await fetchDocument(env, documentId);
  if (!document) return responseJson({ error: "Document not found." }, 404, cors);
  const [logs, history] = await Promise.all([
    env.DB.prepare("SELECT * FROM sds_extraction_logs WHERE document_id = ? ORDER BY created_at DESC LIMIT 50").bind(documentId).all(),
    env.DB.prepare("SELECT * FROM sds_review_history WHERE document_id = ? ORDER BY created_at DESC LIMIT 100").bind(documentId).all()
  ]);
  return responseJson({ document, extraction_logs: logs.results.map(parseAuditRow), review_history: history.results.map(parseHistoryRow) }, 200, cors);
}

async function saveReviewEdits(documentId, request, env, cors) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  if (!reviewer) return responseJson({ error: "Reviewer name is required." }, 400, cors);
  const existing = await env.DB.prepare("SELECT * FROM sds_documents WHERE id = ?").bind(documentId).first();
  if (!existing) return responseJson({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) {
    return responseJson({ error: "This record is already approved. Explicit overwrite confirmation is required." }, 409, cors);
  }

  let metadata;
  try {
    metadata = pickEditableMetadata({ ...metadataFromRow(existing), ...(body.metadata || {}) });
  } catch (error) {
    return responseJson({ error: "Review metadata is invalid.", details: error.issues || [] }, 400, cors);
  }

  await env.DB.batch([
    metadataUpdateStatement(env, documentId, metadata, {
      status: existing.status === "Approved" ? "Needs Review" : existing.status,
      ocrRequired: Boolean(existing.ocr_required),
      method: existing.extraction_method,
      geminiUsed: Boolean(existing.gemini_used),
      extractedText: existing.extracted_text,
      duplicateOfId: existing.duplicate_of_id
    }),
    historyStatement(env, documentId, "Edit review metadata", existing.status, existing.status === "Approved" ? "Needs Review" : existing.status, reviewer, body.metadata || {}, body.comment)
  ]);
  return responseJson({ document: await fetchDocument(env, documentId) }, 200, cors);
}

async function reextractDocument(documentId, request, env, cors) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  if (!reviewer) return responseJson({ error: "Reviewer name is required." }, 400, cors);
  const existing = await env.DB.prepare("SELECT status FROM sds_documents WHERE id = ?").bind(documentId).first();
  if (!existing) return responseJson({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) {
    return responseJson({ error: "Re-extracting an approved record requires explicit confirmation." }, 409, cors);
  }
  try {
    await runExtraction(documentId, env, { reviewer, forceGemini: Boolean(body.forceGemini) });
    return responseJson({ document: await fetchDocument(env, documentId) }, 200, cors);
  } catch (error) {
    return responseJson({ error: `Re-extraction failed: ${safeError(error)}` }, 500, cors);
  }
}

async function approveDocument(documentId, request, env, cors) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  if (!reviewer) return responseJson({ error: "Reviewer name is required." }, 400, cors);
  const existing = await env.DB.prepare("SELECT * FROM sds_documents WHERE id = ?").bind(documentId).first();
  if (!existing) return responseJson({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) {
    return responseJson({ error: "Record is already approved. Explicit overwrite confirmation is required." }, 409, cors);
  }

  let metadata;
  try {
    metadata = pickEditableMetadata({ ...metadataFromRow(existing), ...(body.metadata || {}) });
  } catch (error) {
    return responseJson({ error: "Approval metadata is invalid.", details: error.issues || [] }, 400, cors);
  }
  if (!metadata.product_name && !metadata.trade_name) return responseJson({ error: "Product name or trade name is required for approval." }, 400, cors);

  const approvedFilename = generateApprovedFilename(metadata);
  const collision = await env.DB.prepare(
    "SELECT id, product_name FROM sds_documents WHERE approved_filename = ? AND id <> ? AND status = 'Approved' LIMIT 1"
  ).bind(approvedFilename, documentId).first();
  if (collision && !body.confirmFilenameCollision) {
    return responseJson({ error: "Approved filename already exists. Confirmation is required.", conflict: collision, proposed_filename: approvedFilename }, 409, cors);
  }

  const original = await env.SDS_FILES.get(existing.original_storage_key);
  if (!original) return responseJson({ error: "Original PDF is missing from storage." }, 500, cors);
  const approvedStorageKey = `approved/${documentId}/${approvedFilename}`;
  await env.SDS_FILES.put(approvedStorageKey, original.body, {
    httpMetadata: { contentType: "application/pdf", contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(approvedFilename)}` },
    customMetadata: { originalFilename: existing.original_filename, approvedBy: reviewer, sourceSha256: existing.file_sha256 }
  });

  const now = new Date().toISOString();
  await env.DB.batch([
    metadataUpdateStatement(env, documentId, metadata, {
      status: "Approved",
      ocrRequired: Boolean(existing.ocr_required),
      method: existing.extraction_method,
      geminiUsed: Boolean(existing.gemini_used),
      extractedText: existing.extracted_text,
      duplicateOfId: existing.duplicate_of_id,
      approvedFilename,
      approvedStorageKey,
      approvedAt: now,
      approvedBy: reviewer
    }),
    historyStatement(env, documentId, "Approve", existing.status, "Approved", reviewer, { approved_filename: approvedFilename, metadata }, body.comment)
  ]);
  return responseJson({ document: await fetchDocument(env, documentId), approved_filename: approvedFilename }, 200, cors);
}

async function changeStatus(documentId, targetStatus, action, request, env, cors) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  if (!reviewer) return responseJson({ error: "Reviewer name is required." }, 400, cors);
  const existing = await env.DB.prepare("SELECT status FROM sds_documents WHERE id = ?").bind(documentId).first();
  if (!existing) return responseJson({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) {
    return responseJson({ error: "Changing an approved record requires explicit confirmation." }, 409, cors);
  }
  const now = new Date().toISOString();
  const timestampColumn = targetStatus === "Rejected" ? "rejected_at" : targetStatus === "Archived" ? "archived_at" : null;
  const timestampSql = timestampColumn ? `, ${timestampColumn} = ?` : "";
  const bindings = timestampColumn ? [targetStatus, now, now, documentId] : [targetStatus, now, documentId];
  await env.DB.batch([
    env.DB.prepare(`UPDATE sds_documents SET status = ?, updated_at = ?, version = version + 1${timestampSql} WHERE id = ?`).bind(...bindings),
    historyStatement(env, documentId, action, existing.status, targetStatus, reviewer, null, body.comment)
  ]);
  return responseJson({ document: await fetchDocument(env, documentId) }, 200, cors);
}

async function markDuplicate(documentId, request, env, cors) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  if (!reviewer || !body.duplicate_of_id) return responseJson({ error: "Reviewer and duplicate_of_id are required." }, 400, cors);
  if (body.duplicate_of_id === documentId) return responseJson({ error: "A record cannot duplicate itself." }, 400, cors);
  const [existing, target] = await Promise.all([
    env.DB.prepare("SELECT status FROM sds_documents WHERE id = ?").bind(documentId).first(),
    env.DB.prepare("SELECT id FROM sds_documents WHERE id = ?").bind(body.duplicate_of_id).first()
  ]);
  if (!existing || !target) return responseJson({ error: "Document or duplicate target was not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return responseJson({ error: "Marking an approved record as duplicate requires confirmation." }, 409, cors);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE sds_documents SET status = 'Duplicate', possible_duplicate_flag = 1, duplicate_of_id = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .bind(body.duplicate_of_id, now, documentId),
    historyStatement(env, documentId, "Mark duplicate", existing.status, "Duplicate", reviewer, { duplicate_of_id: body.duplicate_of_id }, body.comment)
  ]);
  return responseJson({ document: await fetchDocument(env, documentId) }, 200, cors);
}

async function dashboard(env, cors) {
  const [counts, reviewAge, recent] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM sds_documents GROUP BY status").all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM sds_documents WHERE status = 'Needs Review' AND updated_at < datetime('now', '-7 days')").first(),
    env.DB.prepare("SELECT id, original_filename, product_name, trade_name, status, extraction_confidence, updated_at FROM sds_documents ORDER BY updated_at DESC LIMIT 10").all()
  ]);
  return responseJson({
    counts: Object.fromEntries(SDS_STATUSES.map((status) => [status, counts.results.find((item) => item.status === status)?.count || 0])),
    overdue_review_count: reviewAge?.count || 0,
    recent: recent.results
  }, 200, cors);
}

async function duplicateList(env, cors) {
  const result = await env.DB.prepare(`
    SELECT id, original_filename, product_name, trade_name, revision_date, status,
           file_sha256, possible_duplicate_flag, duplicate_of_id, updated_at
    FROM sds_documents
    WHERE possible_duplicate_flag = 1
       OR file_sha256 IN (SELECT file_sha256 FROM sds_documents GROUP BY file_sha256 HAVING COUNT(*) > 1)
    ORDER BY file_sha256, updated_at DESC
  `).all();
  return responseJson({ documents: result.results }, 200, cors);
}

async function publicCatalog(request, env, cors) {
  if (!env.DB) return responseJson({ error: "Catalog database is unavailable." }, 503, cors);
  const result = await env.DB.prepare(`
    SELECT id, approved_filename, product_name, trade_name, supplier, manufacturer, language,
           revision_date, signal_word, ghs_pictograms, hazard_statements, recommended_use, updated_at
    FROM sds_documents WHERE status = 'Approved' ORDER BY COALESCE(product_name, trade_name)
  `).all();
  const origin = new URL(request.url).origin;
  return responseJson({
    schemaVersion: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    documents: result.results.map((row) => ({
      id: row.id,
      name: row.product_name || row.trade_name,
      file: row.approved_filename,
      pdfUrl: `${origin}/v1/documents/${row.id}/file`,
      department: "Unassigned",
      revisionDate: row.revision_date || "",
      documentType: "SDS",
      manufacturer: row.manufacturer || row.supplier || "",
      language: row.language || "",
      hazards: parseJsonArray(row.hazard_statements).slice(0, 6),
      signalWord: row.signal_word || "",
      recommendedUse: row.recommended_use || ""
    }))
  }, 200, cors);
}

async function streamDocumentFile(documentId, variant, request, env, cors, admin) {
  if (!env.DB || !env.SDS_FILES) return responseJson({ error: "File storage is unavailable." }, 503, cors);
  const row = await env.DB.prepare("SELECT * FROM sds_documents WHERE id = ?").bind(documentId).first();
  if (!row) return responseJson({ error: "Document not found." }, 404, cors);
  if (!admin && row.status !== "Approved") return responseJson({ error: "Approved document not found." }, 404, cors);

  const useOriginal = admin && variant === "original";
  const key = useOriginal ? row.original_storage_key : row.approved_storage_key;
  const filename = useOriginal ? row.original_filename : row.approved_filename;
  if (!key) return responseJson({ error: "Requested file variant is unavailable." }, 404, cors);
  const object = await env.SDS_FILES.get(key);
  if (!object) return responseJson({ error: "Stored PDF is unavailable." }, 404, cors);
  const headers = new Headers(cors || {});
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename || "sds.pdf")}`);
  headers.set("Cache-Control", admin ? "no-store" : "public, max-age=300");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

function metadataUpdateStatement(env, documentId, metadata, options) {
  const now = new Date().toISOString();
  const approvedFields = options.status === "Approved"
    ? ", approved_filename = ?, approved_storage_key = ?, approved_at = ?, approved_by = ?"
    : "";
  const values = [
    options.status,
    metadata.is_likely_sds ? 1 : 0,
    options.ocrRequired ? 1 : 0,
    options.method || null,
    options.geminiUsed ? 1 : 0,
    String(options.extractedText || "").slice(0, MAX_TEXT_AUDIT_LENGTH),
    metadata.product_name,
    metadata.trade_name,
    metadata.supplier,
    metadata.manufacturer,
    metadata.language,
    metadata.issue_date,
    metadata.revision_date,
    JSON.stringify(metadata.cas_numbers),
    metadata.signal_word,
    JSON.stringify(metadata.ghs_pictograms),
    JSON.stringify(metadata.hazard_statements),
    JSON.stringify(metadata.precautionary_statements),
    metadata.recommended_use,
    metadata.ppe_recommendation,
    metadata.storage_summary,
    metadata.first_aid_summary,
    metadata.spill_response_summary,
    metadata.firefighting_summary,
    metadata.disposal_summary,
    Math.round(metadata.extraction_confidence),
    JSON.stringify(metadata.missing_fields),
    metadata.possible_duplicate_flag ? 1 : 0,
    options.duplicateOfId || null,
    metadata.review_required_reason,
    now
  ];
  if (options.status === "Approved") {
    values.push(options.approvedFilename, options.approvedStorageKey, options.approvedAt, options.approvedBy);
  }
  values.push(documentId);

  return env.DB.prepare(`
    UPDATE sds_documents SET
      status = ?, is_likely_sds = ?, ocr_required = ?, extraction_method = ?, gemini_used = ?, extracted_text = ?,
      product_name = ?, trade_name = ?, supplier = ?, manufacturer = ?, language = ?, issue_date = ?, revision_date = ?,
      cas_numbers = ?, signal_word = ?, ghs_pictograms = ?, hazard_statements = ?, precautionary_statements = ?,
      recommended_use = ?, ppe_recommendation = ?, storage_summary = ?, first_aid_summary = ?, spill_response_summary = ?,
      firefighting_summary = ?, disposal_summary = ?, extraction_confidence = ?, missing_fields = ?,
      possible_duplicate_flag = ?, duplicate_of_id = ?, review_required_reason = ?, updated_at = ?, version = version + 1
      ${approvedFields}
    WHERE id = ?
  `).bind(...values);
}

function extractionLogStatement(env, documentId, stage, method, status, model, confidence, keywordHits, response, errorMessage, textLength = 0) {
  return env.DB.prepare(`
    INSERT INTO sds_extraction_logs (
      id, document_id, stage, method, status, model, confidence, text_length,
      keyword_hits, response_json, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), documentId, stage, method, status, model, confidence,
    Math.max(0, Number(textLength) || 0),
    JSON.stringify(keywordHits || []),
    response ? JSON.stringify(response) : null,
    errorMessage || null,
    new Date().toISOString()
  );
}

function historyStatement(env, documentId, action, fromStatus, toStatus, reviewer, changes, comment) {
  return env.DB.prepare(`
    INSERT INTO sds_review_history (
      id, document_id, action, from_status, to_status, reviewer, changes_json, comment, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), documentId, action, fromStatus, toStatus, cleanReviewer(reviewer) || "System",
    changes ? JSON.stringify(changes) : null,
    comment ? String(comment).slice(0, 2000) : null,
    new Date().toISOString()
  );
}

async function fetchDocument(env, id) {
  const row = await env.DB.prepare("SELECT * FROM sds_documents WHERE id = ?").bind(id).first();
  return row ? rowToDocument(row) : null;
}

function rowToDocument(row) {
  const document = { ...row };
  for (const field of ["cas_numbers", "ghs_pictograms", "hazard_statements", "precautionary_statements", "missing_fields"]) {
    document[field] = parseJsonArray(row[field]);
  }
  for (const field of ["is_likely_sds", "ocr_required", "gemini_used", "possible_duplicate_flag"]) {
    document[field] = Boolean(row[field]);
  }
  return document;
}

function metadataFromRow(row) {
  const metadata = emptyExtraction();
  for (const key of Object.keys(metadata)) {
    if (Array.isArray(metadata[key])) metadata[key] = parseJsonArray(row[key]);
    else if (typeof metadata[key] === "boolean") metadata[key] = Boolean(row[key]);
    else metadata[key] = row[key] ?? metadata[key];
  }
  return extractionSchema.parse(metadata);
}

function parseAuditRow(row) {
  return {
    ...row,
    keyword_hits: parseJsonArray(row.keyword_hits),
    response_json: parseJsonObject(row.response_json)
  };
}

function parseHistoryRow(row) {
  return { ...row, changes_json: parseJsonObject(row.changes_json) };
}

function parseJsonObject(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function cleanReviewer(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 100);
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function validateBindings(env) {
  if (!env.DB) return "D1 database binding DB is not configured.";
  if (!env.SDS_FILES) return "R2 bucket binding SDS_FILES is not configured.";
  return "";
}

async function isAuthorized(request, expectedToken) {
  if (!expectedToken) return false;
  const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedToken))
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0 && provided.length > 0;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin) return {};
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function responseJson(payload, status = 200, extraHeaders = {}) {
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

function safeError(error) {
  return String(error?.message || error || "Unknown error").replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
