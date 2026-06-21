import { assessSdsText, extractFirstTwoPages, extractWithGemini, extractWithRegex, mergeExtraction, shouldUseGemini } from "../_shared/extraction.ts";
import { generateApprovedFilename, sha256Hex } from "../_shared/filename.ts";
import { insertRows, nowIso, selectRows, updateRows } from "../_shared/database.ts";
import { downloadPrivateAsset, uploadApproved, uploadOriginal } from "../_shared/github-releases.ts";
import { emptyExtraction, extractionSchema, pickEditableMetadata, SDS_STATUSES, type Extraction } from "../_shared/schema.ts";
import { computeValidity } from "../_shared/validity.ts";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_AUDIT_LENGTH = 50000;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ASK_PDF_MAX_BYTES = 12 * 1024 * 1024;
const ASK_RATE_LIMIT = 10;
const ASK_RATE_WINDOW_MS = 60000;
const ASK_GEMINI_TIMEOUT_MS = 25000;
const STATIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let catalogCache: { fetchedAt: number; documents: Record<string, unknown>[] } | null = null;

Deno.serve(async (request) => {
  try {
    return await route(request);
  } catch (error) {
    const detail = safeError(error);
    console.error("SDS API error", detail);
    const adminRequest = apiPath(new URL(request.url).pathname).startsWith("/v1/admin") && await authorized(request).catch(() => false);
    return json({
      error: "The SDS service could not complete the request.",
      ...(adminRequest ? { detail } : {})
    }, 500, corsHeaders(request));
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

  const publicFile = path.match(/^\/v1\/documents\/([a-f0-9-]+)\/file$/i);
  if (publicFile && request.method === "GET") return streamFile(publicFile[1], "approved", false, cors);

  if (path === "/v1/ask" && request.method === "POST") return askQuestion(request, cors);

  if (!path.startsWith("/v1/admin")) return json({ error: "Not found." }, 404, cors);
  if (!await authorized(request)) return json({ error: "Administrator authorization is required." }, 401, { ...cors, "WWW-Authenticate": "Bearer" });

  if (path === "/v1/admin/documents" && request.method === "POST") return uploadDocument(request, cors);
  if (path === "/v1/admin/documents" && request.method === "GET") return listDocuments(url, cors);
  if (path === "/v1/admin/dashboard" && request.method === "GET") return dashboard(cors);
  if (path === "/v1/admin/duplicates" && request.method === "GET") return duplicateList(cors);

  const match = path.match(/^\/v1\/admin\/documents\/([a-f0-9-]+)(?:\/(extract|approve|reject|duplicate|archive|file))?$/i);
  if (!match || !UUID_PATTERN.test(match[1])) return json({ error: "Admin endpoint not found." }, 404, cors);
  const [, id, action = ""] = match;
  if (!action && request.method === "GET") return getDocument(id, cors);
  if (!action && request.method === "PATCH") return saveReview(id, request, cors);
  if (action === "extract" && request.method === "POST") return reextract(id, request, cors);
  if (action === "approve" && request.method === "POST") return approve(id, request, cors);
  if (action === "reject" && request.method === "POST") return changeStatus(id, "Rejected", "Reject", request, cors);
  if (action === "archive" && request.method === "POST") return changeStatus(id, "Archived", "Archive", request, cors);
  if (action === "duplicate" && request.method === "POST") return markDuplicate(id, request, cors);
  if (action === "file" && request.method === "GET") return streamFile(id, url.searchParams.get("variant") || "original", true, cors);
  return json({ error: "Method not allowed." }, 405, cors);
}

async function uploadDocument(request: Request, cors: Record<string, string> | null) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const reviewer = cleanReviewer(form?.get("reviewer") || "Admin uploader");
  if (!(file instanceof File)) return json({ error: "A PDF file is required." }, 400, cors);
  if (file.size < 5 || file.size > MAX_UPLOAD_BYTES) return json({ error: "PDF must be between 5 bytes and 15 MB." }, 413, cors);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") return json({ error: "The uploaded file does not have a valid PDF signature." }, 400, cors);

  const id = crypto.randomUUID();
  const originalFilename = String(file.name || "uploaded-sds.pdf").slice(0, 255);
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
    file_size: file.size,
    status: "Uploaded",
    possible_duplicate_flag: Boolean(duplicate),
    duplicate_of_id: duplicate?.id || null,
    created_at: now,
    updated_at: now
  }, false);
  await history(id, "Upload", null, "Uploaded", reviewer, { original_filename: originalFilename, sha256: digest }, duplicate ? "Exact file hash already exists." : null);

  try {
    await runExtraction(id, bytes, reviewer, false);
  } catch (error) {
    const reason = `Extraction failed: ${safeError(error)}`;
    await updateRows("sds_documents", `id=eq.${id}`, { status: "Needs Review", review_required_reason: reason, updated_at: nowIso() }, false);
    await extractionLog(id, "Extraction", "pdf-text", "Error", null, 0, [], null, reason, 0);
  }
  return json({ document: await fetchDocument(id) }, 201, cors);
}

async function runExtraction(id: string, suppliedBytes: Uint8Array | null, reviewer: string, forceGemini: boolean) {
  const document = await fetchDocument(id);
  if (!document) throw new Error("Document not found");
  await updateRows("sds_documents", `id=eq.${id}`, { status: "Parsing", updated_at: nowIso(), version: document.version + 1 }, false);
  await history(id, "Start extraction", document.status, "Parsing", reviewer, null, null);

  const bytes = suppliedBytes || await downloadPrivateAsset(Number(document.original_asset_id));
  let textResult = { text: "", pagesExtracted: 0, totalPages: 0 };
  let textError = "";
  try { textResult = await extractFirstTwoPages(bytes); } catch (error) { textError = safeError(error); }
  const assessment = assessSdsText(textResult.text);
  const regex = extractWithRegex(textResult.text);
  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  let gemini: Extraction | null = null;
  let geminiError = "";
  if ((forceGemini || shouldUseGemini(regex, assessment.weakText, geminiKey)) && geminiKey) {
    try { gemini = await extractWithGemini(bytes, textResult.text, geminiKey, model); } catch (error) { geminiError = safeError(error); }
  }

  const candidates = await selectRows("sds_documents", `select=id,product_name,trade_name,revision_date,status&status=neq.Archived&limit=1000`);
  const product = regex.product_name || regex.trade_name || gemini?.product_name || gemini?.trade_name;
  const revision = regex.revision_date || gemini?.revision_date || "";
  const metadataDuplicate = product ? candidates.find((item: Record<string, unknown>) => (
    item.id !== id && String(item.product_name || item.trade_name || "").toLowerCase() === product.toLowerCase()
      && String(item.revision_date || "") === revision
  )) : null;
  const activeExistingDuplicate = candidates.find((item: Record<string, unknown>) => item.id === document.duplicate_of_id);
  const duplicateOfId = activeExistingDuplicate?.id || metadataDuplicate?.id || null;
  const merged = mergeExtraction(regex, gemini, { ocrRequired: assessment.weakText || Boolean(textError), duplicate: Boolean(duplicateOfId) });
  if (geminiError) merged.review_required_reason = `${merged.review_required_reason}. Gemini fallback failed: ${geminiError}`;
  if (textError) merged.review_required_reason = `${merged.review_required_reason}. PDF text extraction failed: ${textError}`;
  const method = gemini ? (assessment.weakText ? "pdf-text+gemini-ocr" : "pdf-text+regex+gemini") : "pdf-text+regex";

  await updateRows("sds_documents", `id=eq.${id}`, {
    ...metadataColumns(merged),
    status: "Extracted",
    ocr_required: assessment.weakText || Boolean(textError),
    extraction_method: method,
    gemini_used: Boolean(gemini),
    extracted_text: textResult.text.slice(0, MAX_TEXT_AUDIT_LENGTH),
    duplicate_of_id: duplicateOfId,
    updated_at: nowIso(),
    version: document.version + 2
  }, false);
  await extractionLog(id, "Extraction", method, geminiError ? "Completed with warning" : "Completed", gemini ? model : null, merged.extraction_confidence, assessment.keywordHits, merged, geminiError || textError, textResult.text.length);
  await history(id, "Complete extraction", "Parsing", "Extracted", reviewer, { extraction_method: method }, null);
  await updateRows("sds_documents", `id=eq.${id}`, { status: "Needs Review", updated_at: nowIso(), version: document.version + 3 }, false);
  await history(id, "Route to EHS review", "Extracted", "Needs Review", reviewer, null, merged.review_required_reason);
}

async function listDocuments(url: URL, cors: Record<string, string> | null) {
  const status = url.searchParams.get("status") || "";
  const query = url.searchParams.get("q")?.trim() || "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
  let filter = `select=*&order=updated_at.desc&limit=${limit}`;
  if ((SDS_STATUSES as readonly string[]).includes(status)) filter += `&status=eq.${encodeURIComponent(status)}`;
  if (query) {
    const safe = query.replace(/[,*()]/g, " ").trim();
    filter += `&or=(product_name.ilike.*${encodeURIComponent(safe)}*,trade_name.ilike.*${encodeURIComponent(safe)}*,original_filename.ilike.*${encodeURIComponent(safe)}*)`;
  }
  return json({ documents: await selectRows("sds_documents", filter) }, 200, cors);
}

async function getDocument(id: string, cors: Record<string, string> | null) {
  const document = await fetchDocument(id);
  if (!document) return json({ error: "Document not found." }, 404, cors);
  const [logs, reviewHistory] = await Promise.all([
    selectRows("sds_extraction_logs", `select=*&document_id=eq.${id}&order=created_at.desc&limit=50`),
    selectRows("sds_review_history", `select=*&document_id=eq.${id}&order=created_at.desc&limit=100`)
  ]);
  return json({ document, extraction_logs: logs, review_history: reviewHistory }, 200, cors);
}

async function saveReview(id: string, request: Request, cors: Record<string, string> | null) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  const existing = await fetchDocument(id);
  if (!reviewer) return json({ error: "Reviewer name is required." }, 400, cors);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "This record is already approved. Explicit overwrite confirmation is required." }, 409, cors);
  let metadata: Extraction;
  try { metadata = pickEditableMetadata({ ...metadataFromRow(existing), ...(body.metadata || {}) }); }
  catch (error) { return json({ error: "Review metadata is invalid.", details: error?.issues || [] }, 400, cors); }
  const nextStatus = existing.status === "Approved" ? "Needs Review" : existing.status;
  await updateRows("sds_documents", `id=eq.${id}`, { ...metadataColumns(metadata), status: nextStatus, updated_at: nowIso(), version: existing.version + 1 }, false);
  await history(id, "Edit review metadata", existing.status, nextStatus, reviewer, body.metadata || {}, body.comment);
  return json({ document: await fetchDocument(id) }, 200, cors);
}

async function reextract(id: string, request: Request, cors: Record<string, string> | null) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  const existing = await fetchDocument(id);
  if (!reviewer) return json({ error: "Reviewer name is required." }, 400, cors);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Re-extracting an approved record requires explicit confirmation." }, 409, cors);
  await runExtraction(id, null, reviewer, Boolean(body.forceGemini));
  return json({ document: await fetchDocument(id) }, 200, cors);
}

async function approve(id: string, request: Request, cors: Record<string, string> | null) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  const existing = await fetchDocument(id);
  if (!reviewer) return json({ error: "Reviewer name is required." }, 400, cors);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Record is already approved. Explicit overwrite confirmation is required." }, 409, cors);
  let metadata: Extraction;
  try { metadata = pickEditableMetadata({ ...metadataFromRow(existing), ...(body.metadata || {}) }); }
  catch (error) { return json({ error: "Approval metadata is invalid.", details: error?.issues || [] }, 400, cors); }
  if (!metadata.product_name && !metadata.trade_name) return json({ error: "Product name or trade name is required for approval." }, 400, cors);
  const filename = generateApprovedFilename(metadata as unknown as Record<string, unknown>);
  const collisions = await selectRows("sds_documents", `select=id,product_name&approved_filename=eq.${encodeURIComponent(filename)}&status=eq.Approved&id=neq.${id}&limit=1`);
  if (collisions.length) return json({ error: "Approved filename already exists. Change the metadata or mark this document as a duplicate; existing approved files are never overwritten.", conflict: collisions[0], proposed_filename: filename }, 409, cors);
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
    approved_by: reviewer,
    updated_at: approvedAt,
    version: existing.version + 1
  }, false);
  await history(id, "Approve", existing.status, "Approved", reviewer, { approved_filename: filename, metadata }, body.comment);
  return json({ document: await fetchDocument(id), approved_filename: filename }, 200, cors);
}

async function changeStatus(id: string, target: string, action: string, request: Request, cors: Record<string, string> | null) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  const existing = await fetchDocument(id);
  if (!reviewer) return json({ error: "Reviewer name is required." }, 400, cors);
  if (!existing) return json({ error: "Document not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Changing an approved record requires explicit confirmation." }, 409, cors);
  const changes: Record<string, unknown> = { status: target, updated_at: nowIso(), version: existing.version + 1 };
  if (target === "Rejected") changes.rejected_at = nowIso();
  if (target === "Archived") changes.archived_at = nowIso();
  await updateRows("sds_documents", `id=eq.${id}`, changes, false);
  await history(id, action, existing.status, target, reviewer, null, body.comment);
  return json({ document: await fetchDocument(id) }, 200, cors);
}

async function markDuplicate(id: string, request: Request, cors: Record<string, string> | null) {
  const body = await readJson(request);
  const reviewer = cleanReviewer(body.reviewer);
  if (!reviewer || !UUID_PATTERN.test(String(body.duplicate_of_id || ""))) return json({ error: "Reviewer and a valid duplicate_of_id are required." }, 400, cors);
  if (body.duplicate_of_id === id) return json({ error: "A record cannot duplicate itself." }, 400, cors);
  const [existing, target] = await Promise.all([fetchDocument(id), fetchDocument(body.duplicate_of_id)]);
  if (!existing || !target) return json({ error: "Document or duplicate target was not found." }, 404, cors);
  if (existing.status === "Approved" && !body.confirmOverwrite) return json({ error: "Marking an approved record as duplicate requires confirmation." }, 409, cors);
  await updateRows("sds_documents", `id=eq.${id}`, { status: "Duplicate", possible_duplicate_flag: true, duplicate_of_id: body.duplicate_of_id, updated_at: nowIso(), version: existing.version + 1 }, false);
  await history(id, "Mark duplicate", existing.status, "Duplicate", reviewer, { duplicate_of_id: body.duplicate_of_id }, body.comment);
  return json({ document: await fetchDocument(id) }, 200, cors);
}

async function dashboard(cors: Record<string, string> | null) {
  const rows = await selectRows("sds_documents", "select=id,original_filename,product_name,trade_name,status,extraction_confidence,updated_at&order=updated_at.desc&limit=1000");
  const counts = Object.fromEntries(SDS_STATUSES.map((status) => [status, rows.filter((row: Record<string, unknown>) => row.status === status).length]));
  const overdue = Date.now() - 7 * 86400000;
  return json({
    counts,
    overdue_review_count: rows.filter((row: Record<string, unknown>) => row.status === "Needs Review" && new Date(String(row.updated_at)).getTime() < overdue).length,
    recent: rows.slice(0, 10)
  }, 200, cors);
}

async function duplicateList(cors: Record<string, string> | null) {
  const rows = await selectRows("sds_documents", "select=id,original_filename,product_name,trade_name,revision_date,status,file_sha256,possible_duplicate_flag,duplicate_of_id,updated_at&order=updated_at.desc&limit=1000");
  const hashes = new Map<string, number>();
  for (const row of rows) hashes.set(row.file_sha256, (hashes.get(row.file_sha256) || 0) + 1);
  return json({ documents: rows.filter((row: Record<string, unknown>) => row.possible_duplicate_flag || (hashes.get(String(row.file_sha256)) || 0) > 1) }, 200, cors);
}

async function publicCatalog(cors: Record<string, string> | null) {
  const rows = await selectRows("sds_documents", "select=id,approved_filename,approved_download_url,product_name,trade_name,supplier,manufacturer,language,revision_date,established_date,expiry_date,signal_word,hazard_statements,recommended_use,updated_at&status=eq.Approved&order=product_name.asc.nullslast,trade_name.asc");
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
      hazards: Array.isArray(row.hazard_statements) ? row.hazard_statements.slice(0, 6) : [],
      signalWord: row.signal_word || "",
      recommendedUse: row.recommended_use || ""
    }))
  }, 200, cors);
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
    const rows = await selectRows("sds_documents", `select=product_name,trade_name,revision_date,approved_download_url,status&id=eq.${chemicalId}&status=eq.Approved&limit=1`);
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

async function fetchAskPdf(pdfUrl: string) {
  const parsed = new URL(pdfUrl);
  const allowedHosts = new Set([
    new URL(pagesBaseUrl()).host, "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"
  ]);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.host)) throw new Error("Disallowed SDS PDF location");
  const response = await fetch(pdfUrl, { headers: { Accept: "application/pdf" }, redirect: "follow" });
  if (!response.ok) throw new Error(`SDS PDF returned HTTP ${response.status}`);
  if (Number(response.headers.get("Content-Length") || 0) > ASK_PDF_MAX_BYTES) throw new Error("SDS PDF exceeds the AI size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > ASK_PDF_MAX_BYTES) throw new Error("SDS PDF exceeds the AI size limit");
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
  const repository = Deno.env.get("GITHUB_REPOSITORY") || "izzulwork1/sds-hub";
  const [owner, name] = repository.split("/");
  return `https://${owner}.github.io/${name}/`;
}

function askBytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function streamFile(id: string, variant: string, admin: boolean, cors: Record<string, string> | null) {
  const document = await fetchDocument(id);
  if (!document || (!admin && document.status !== "Approved")) return json({ error: "Approved document not found." }, 404, cors);
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
  const validity = computeValidity(metadata.issue_date, metadata.revision_date);
  return {
    is_likely_sds: metadata.is_likely_sds,
    product_name: metadata.product_name,
    trade_name: metadata.trade_name,
    supplier: metadata.supplier,
    manufacturer: metadata.manufacturer,
    language: metadata.language,
    issue_date: metadata.issue_date,
    revision_date: metadata.revision_date,
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

async function history(documentId: string, action: string, fromStatus: string | null, toStatus: string | null, reviewer: string, changes: unknown, comment: unknown) {
  await insertRows("sds_review_history", {
    document_id: documentId, action, from_status: fromStatus, to_status: toStatus,
    reviewer: cleanReviewer(reviewer) || "System", changes_json: changes,
    comment: comment ? String(comment).slice(0, 2000) : null
  }, false);
}

async function authorized(request: Request) {
  const expected = Deno.env.get("ADMIN_API_TOKEN") || "";
  const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || !provided) return false;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)), crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(leftHash), right = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function apiPath(pathname: string) {
  const marker = "/sds-api";
  const index = pathname.lastIndexOf(marker);
  return index >= 0 ? pathname.slice(index + marker.length) || "/" : pathname;
}

function corsHeaders(request: Request) {
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
async function readJson(request: Request): Promise<Record<string, any>> { try { return await request.json(); } catch { return {}; } }
function safeError(error: unknown) { return String((error as Error)?.message || error || "Unknown error").replace(/[\r\n\t]+/g, " ").slice(0, 500); }
