const config = window.SDS_CONFIG || {};
const STATUSES = ["Uploaded","Parsing","Extracted","Needs Review","Approved","Rejected","Archived","Duplicate"];
const ARRAY_FIELDS = new Set(["cas_numbers","ghs_pictograms","hazard_statements","precautionary_statements","missing_fields"]);
const LONG_FIELDS = new Set(["recommended_use","ppe_recommendation","storage_summary","first_aid_summary","spill_response_summary","firefighting_summary","disposal_summary","review_required_reason"]);
const FIELD_DEFINITIONS = [
  ["is_likely_sds","Likely valid SDS","checkbox"],
  ["product_name","Formal product name","text"],
  ["trade_name","Trade name","text"],
  ["supplier","Supplier","text"],
  ["manufacturer","Manufacturer","text"],
  ["language","Language","text"],
  ["issue_date","Issue date","text"],
  ["revision_date","Revision date","text"],
  ["cas_numbers","CAS numbers (one per line)","array"],
  ["signal_word","Signal word","text"],
  ["ghs_pictograms","GHS pictograms (one per line)","array"],
  ["hazard_statements","Hazard statements (one per line)","array"],
  ["precautionary_statements","Precautionary statements (one per line)","array"],
  ["recommended_use","Recommended use","long"],
  ["ppe_recommendation","PPE recommendation","long"],
  ["storage_summary","Storage summary","long"],
  ["first_aid_summary","First-aid summary","long"],
  ["spill_response_summary","Spill response summary","long"],
  ["firefighting_summary","Firefighting summary","long"],
  ["disposal_summary","Disposal summary","long"],
  ["extraction_confidence","Extraction confidence (0-100)","number"],
  ["missing_fields","Missing fields (one per line)","array"],
  ["possible_duplicate_flag","Possible duplicate","checkbox"],
  ["review_required_reason","Review-required reason","long"]
];

const state = {
  apiUrl: String(config.adminApiUrl || "").replace(/\/$/, ""),
  token: sessionStorage.getItem("sds-admin-token") || "",
  reviewer: sessionStorage.getItem("sds-reviewer") || "",
  currentView: "dashboard",
  selectedId: "",
  selectedDocument: null
};

const elements = Object.fromEntries([
  "connectionBadge","connectionPanel","workspace","apiUrlInput","reviewerInput","adminTokenInput","connectButton",
  "dashboardCards","recentTable","uploadForm","pdfInput","uploadButton","uploadResult","queueTable","reviewList",
  "reviewForm","reviewStatus","reviewTitle","reviewOriginal","reviewWarnings","reviewFields","reviewComment",
  "openOriginalButton","saveReviewButton","reextractButton","duplicateButton","archiveButton","rejectButton","approveButton",
  "masterSearch","masterStatus","masterSearchButton","masterTable","duplicateTable","detailContent","detailNav","adminToast"
].map((id) => [id, document.getElementById(id)]));

let toastTimer;

function initialize() {
  elements.apiUrlInput.value = state.apiUrl;
  elements.reviewerInput.value = state.reviewer;
  for (const status of STATUSES) elements.masterStatus.append(new Option(status, status));
  bindEvents();
  if (state.apiUrl && state.token && state.reviewer) connect();
}

function bindEvents() {
  document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-refresh]").forEach((button) => button.addEventListener("click", () => refreshView(button.dataset.refresh)));
  elements.connectButton.addEventListener("click", connect);
  elements.uploadForm.addEventListener("submit", uploadDocument);
  elements.masterSearchButton.addEventListener("click", handleAsync(loadMaster));
  elements.openOriginalButton.addEventListener("click", () => openFile("original"));
  elements.saveReviewButton.addEventListener("click", handleAsync(saveReview));
  elements.reextractButton.addEventListener("click", handleAsync(reextract));
  elements.duplicateButton.addEventListener("click", handleAsync(markDuplicate));
  elements.archiveButton.addEventListener("click", handleAsync(() => statusAction("archive", "Archive this record?")));
  elements.rejectButton.addEventListener("click", handleAsync(() => statusAction("reject", "Reject this SDS intake record?")));
  elements.approveButton.addEventListener("click", handleAsync(approve));
}

function handleAsync(action) {
  return (event) => Promise.resolve(action(event)).catch((error) => showToast(error?.message || "The request failed."));
}

async function connect() {
  const apiUrl = validateApiUrl(elements.apiUrlInput.value);
  const reviewer = elements.reviewerInput.value.trim();
  const token = elements.adminTokenInput.value || state.token;
  if (!apiUrl || !reviewer || !token) return showToast("API URL, reviewer name, and admin token are required.");
  state.apiUrl = apiUrl;
  state.reviewer = reviewer;
  state.token = token;
  sessionStorage.setItem("sds-admin-token", token);
  sessionStorage.setItem("sds-reviewer", reviewer);
  try {
    await api("/v1/admin/dashboard");
    elements.connectionPanel.hidden = true;
    elements.workspace.hidden = false;
    elements.connectionBadge.textContent = `Connected as ${reviewer}`;
    elements.connectionBadge.classList.add("is-connected");
    await showView("dashboard");
  } catch (error) {
    showToast(error.message);
  }
}

async function showView(view) {
  if (!elements.workspace.hidden && view === "detail" && !state.selectedId) return;
  state.currentView = view;
  document.querySelectorAll(".admin-view").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  await refreshView(view);
}

async function refreshView(view) {
  try {
    if (view === "dashboard") await loadDashboard();
    if (view === "queue") await loadQueue();
    if (view === "review") await loadReviewList();
    if (view === "master") await loadMaster();
    if (view === "duplicates") await loadDuplicates();
    if (view === "detail" && state.selectedId) await loadDetail(state.selectedId);
  } catch (error) {
    showToast(error.message);
  }
}

async function loadDashboard() {
  const data = await api("/v1/admin/dashboard");
  const important = ["Uploaded","Parsing","Needs Review","Approved","Duplicate","Rejected","Archived"];
  elements.dashboardCards.replaceChildren(...important.map((status) => node("article", { className:"metric-card" }, [
    node("strong", { textContent:String(data.counts[status] || 0) }), node("span", { textContent:status })
  ])));
  renderDocumentTable(elements.recentTable, data.recent || [], { compact:true });
}

async function loadQueue() {
  const results = await Promise.all(["Uploaded","Parsing","Extracted"].map((status) => api(`/v1/admin/documents?status=${encodeURIComponent(status)}`)));
  renderDocumentTable(elements.queueTable, results.flatMap((item) => item.documents || []));
}

async function loadReviewList() {
  const data = await api("/v1/admin/documents?status=Needs%20Review&limit=200");
  const documents = data.documents || [];
  if (!documents.length) {
    elements.reviewList.replaceChildren(emptyState("No documents currently need EHS review."));
    elements.reviewForm.hidden = true;
    return;
  }
  elements.reviewList.replaceChildren(...documents.map((documentRecord) => {
    const button = node("button", { className:"review-item", type:"button" }, [
      node("strong", { textContent:displayName(documentRecord) }),
      node("span", { textContent:`${documentRecord.original_filename} - ${documentRecord.extraction_confidence || 0}% confidence` })
    ]);
    button.classList.toggle("is-active", documentRecord.id === state.selectedId);
    button.addEventListener("click", () => openReview(documentRecord.id));
    return button;
  }));
  if (!state.selectedId || !documents.some((item) => item.id === state.selectedId)) await openReview(documents[0].id);
}

async function openReview(documentId) {
  const data = await api(`/v1/admin/documents/${documentId}`);
  state.selectedId = documentId;
  state.selectedDocument = data.document;
  elements.detailNav.disabled = false;
  renderReviewForm(data.document);
  elements.reviewForm.hidden = false;
  elements.reviewList.querySelectorAll(".review-item").forEach((button, index) => button.classList.toggle("is-active", index === [...elements.reviewList.children].findIndex((item) => item.textContent.includes(data.document.original_filename))));
}

function renderReviewForm(documentRecord) {
  elements.reviewStatus.textContent = documentRecord.status;
  elements.reviewStatus.dataset.status = documentRecord.status;
  elements.reviewTitle.textContent = displayName(documentRecord);
  elements.reviewOriginal.textContent = `Original: ${documentRecord.original_filename}`;
  const warnings = [
    documentRecord.ocr_required ? "OCR or visual verification is required." : "",
    documentRecord.possible_duplicate_flag ? `Possible duplicate${documentRecord.duplicate_of_id ? ` of ${documentRecord.duplicate_of_id}` : ""}.` : "",
    documentRecord.review_required_reason || ""
  ].filter(Boolean);
  elements.reviewWarnings.hidden = !warnings.length;
  elements.reviewWarnings.textContent = warnings.join("\n");
  elements.reviewFields.replaceChildren(...FIELD_DEFINITIONS.map(([field,label,type]) => createField(field,label,type,documentRecord[field])));
}

function createField(field, labelText, type, value) {
  const label = node("label", { className:LONG_FIELDS.has(field) || ARRAY_FIELDS.has(field) ? "field-wide" : "" });
  label.append(node("span", { textContent:labelText }));
  let input;
  if (type === "checkbox") {
    input = node("input", { type:"checkbox" });
    input.checked = Boolean(value);
  } else if (type === "long" || type === "array") {
    input = node("textarea", { rows:type === "array" ? 4 : 3 });
    input.value = type === "array" ? (value || []).join("\n") : value || "";
  } else {
    input = node("input", { type:type === "number" ? "number" : "text" });
    input.value = value ?? "";
    if (type === "number") { input.min = "0"; input.max = "100"; }
  }
  input.dataset.field = field;
  label.append(input);
  return label;
}

function collectReviewMetadata() {
  const metadata = {};
  elements.reviewFields.querySelectorAll("[data-field]").forEach((input) => {
    const field = input.dataset.field;
    if (input.type === "checkbox") metadata[field] = input.checked;
    else if (ARRAY_FIELDS.has(field)) metadata[field] = input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    else if (input.type === "number") metadata[field] = Math.max(0, Math.min(100, Number(input.value) || 0));
    else metadata[field] = input.value.trim() || null;
  });
  return metadata;
}

async function saveReview() {
  await documentAction("", "PATCH", { metadata:collectReviewMetadata(), comment:elements.reviewComment.value });
  showToast("Review edits saved.");
}

async function approve() {
  if (!confirm("Approve this metadata and create the controlled filename?")) return;
  const payload = { reviewer:state.reviewer, metadata:collectReviewMetadata(), comment:elements.reviewComment.value };
  try {
    const data = await api(`/v1/admin/documents/${state.selectedId}/approve`, { method:"POST", body:payload });
    showToast(`Approved as ${data.approved_filename}`);
    state.selectedDocument = data.document;
    elements.reviewForm.hidden = true;
    state.selectedId = "";
    await loadReviewList();
  } catch (error) {
    if (error.status === 409 && error.data?.proposed_filename && confirm(`${error.message}\n\nApprove despite this filename collision?`)) {
      payload.confirmFilenameCollision = true;
      const data = await api(`/v1/admin/documents/${state.selectedId}/approve`, { method:"POST", body:payload });
      showToast(`Approved as ${data.approved_filename}`);
      await loadReviewList();
      return;
    }
    throw error;
  }
}

async function reextract() {
  if (!confirm("Request a fresh extraction using the original PDF?")) return;
  await documentAction("extract", "POST", { forceGemini:true, comment:elements.reviewComment.value });
  showToast("Re-extraction completed and returned to review.");
}

async function markDuplicate() {
  const duplicateOfId = prompt("Enter the controlling document ID:");
  if (!duplicateOfId) return;
  await documentAction("duplicate", "POST", { duplicate_of_id:duplicateOfId.trim(), comment:elements.reviewComment.value });
  showToast("Document marked as duplicate.");
  state.selectedId = "";
  await loadReviewList();
}

async function statusAction(action, question) {
  if (!confirm(question)) return;
  await documentAction(action, "POST", { comment:elements.reviewComment.value });
  showToast(action === "reject" ? "Record rejected." : "Record archived.");
  state.selectedId = "";
  await loadReviewList();
}

async function documentAction(action, method, data) {
  if (!state.selectedId) throw new Error("Select a document first.");
  const path = `/v1/admin/documents/${state.selectedId}${action ? `/${action}` : ""}`;
  const result = await api(path, { method, body:{ reviewer:state.reviewer, ...data } });
  state.selectedDocument = result.document;
  if (result.document?.status === "Needs Review") renderReviewForm(result.document);
  return result;
}

async function loadMaster() {
  const params = new URLSearchParams({ limit:"200" });
  if (elements.masterStatus.value) params.set("status", elements.masterStatus.value);
  if (elements.masterSearch.value.trim()) params.set("q", elements.masterSearch.value.trim());
  const data = await api(`/v1/admin/documents?${params}`);
  renderDocumentTable(elements.masterTable, data.documents || []);
}

async function loadDuplicates() {
  const data = await api("/v1/admin/duplicates");
  renderDocumentTable(elements.duplicateTable, data.documents || []);
}

function renderDocumentTable(container, documents, { compact = false } = {}) {
  if (!documents.length) return container.replaceChildren(emptyState("No matching SDS records."));
  const table = node("table", { className:"data-table" });
  const head = node("thead");
  const headerRow = node("tr");
  for (const title of compact ? ["Document","Status","Updated","Action"] : ["Document","Original filename","Status","Confidence","Updated","Action"]) headerRow.append(node("th", { textContent:title }));
  head.append(headerRow);
  const body = node("tbody");
  for (const documentRecord of documents) {
    const row = node("tr");
    row.append(node("td", { textContent:displayName(documentRecord) }));
    if (!compact) row.append(node("td", { textContent:documentRecord.original_filename || "-" }));
    const statusCell = node("td");
    const badge = node("span", { className:"status-badge", textContent:documentRecord.status });
    badge.dataset.status = documentRecord.status;
    statusCell.append(badge);
    row.append(statusCell);
    if (!compact) row.append(node("td", { textContent:`${documentRecord.extraction_confidence || 0}%` }));
    row.append(node("td", { textContent:formatDateTime(documentRecord.updated_at) }));
    const actionCell = node("td");
    const button = node("button", { type:"button", textContent:documentRecord.status === "Needs Review" ? "Review" : "View" });
    button.addEventListener("click", () => documentRecord.status === "Needs Review" ? (showView("review"), openReview(documentRecord.id)) : openDetail(documentRecord.id));
    actionCell.append(button);
    row.append(actionCell);
    body.append(row);
  }
  table.append(head, body);
  container.replaceChildren(table);
}

async function openDetail(documentId) {
  state.selectedId = documentId;
  elements.detailNav.disabled = false;
  await showView("detail");
}

async function loadDetail(documentId) {
  const data = await api(`/v1/admin/documents/${documentId}`);
  const documentRecord = data.document;
  const summary = node("section", { className:"detail-card" });
  summary.append(node("h2", { textContent:displayName(documentRecord) }));
  const list = node("dl", { className:"definition-list" });
  const fields = ["status","original_filename","approved_filename","product_name","trade_name","supplier","manufacturer","language","issue_date","revision_date","signal_word","extraction_confidence","extraction_method","ocr_required","possible_duplicate_flag","review_required_reason"];
  for (const field of fields) list.append(node("dt", { textContent:field.replaceAll("_"," ") }), node("dd", { textContent:String(documentRecord[field] ?? "-") }));
  summary.append(list);
  const audit = node("section", { className:"detail-card" });
  audit.append(node("h2", { textContent:"Review history" }));
  const timeline = node("div", { className:"timeline" });
  for (const item of data.review_history || []) timeline.append(node("div", { className:"timeline-item" }, [
    node("strong", { textContent:`${item.action} - ${item.reviewer}` }),
    node("span", { textContent:`${item.from_status || "Start"} -> ${item.to_status || "-"} - ${formatDateTime(item.created_at)}` }),
    item.comment ? node("span", { textContent:item.comment }) : null
  ].filter(Boolean)));
  audit.append(timeline.children.length ? timeline : emptyState("No review history."));
  elements.detailContent.replaceChildren(node("div", { className:"detail-grid" }, [summary,audit]));
}

async function uploadDocument(event) {
  event.preventDefault();
  const file = elements.pdfInput.files[0];
  if (!file) return showToast("Select a PDF first.");
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("reviewer", state.reviewer);
  elements.uploadButton.disabled = true;
  elements.uploadButton.textContent = "Uploading and extracting...";
  elements.uploadResult.hidden = true;
  try {
    const result = await api("/v1/admin/documents", { method:"POST", body:form });
    elements.uploadResult.hidden = false;
    elements.uploadResult.textContent = `${result.document.original_filename} uploaded. Status: ${result.document.status}. Confidence: ${result.document.extraction_confidence || 0}%.`;
    elements.uploadForm.reset();
    state.selectedId = result.document.id;
    elements.detailNav.disabled = false;
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.uploadButton.disabled = false;
    elements.uploadButton.textContent = "Upload and extract";
  }
}

async function openFile(variant) {
  if (!state.selectedId) return;
  try {
    const response = await fetch(`${state.apiUrl}/v1/admin/documents/${state.selectedId}/file?variant=${encodeURIComponent(variant)}`, {
      headers:{ Authorization:`Bearer ${state.token}` }
    });
    if (!response.ok) throw new Error("PDF could not be opened.");
    const url = URL.createObjectURL(await response.blob());
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { showToast(error.message); }
}

async function api(path, options = {}) {
  const headers = { Authorization:`Bearer ${state.token}`, Accept:"application/json" };
  const init = { method:options.method || "GET", headers };
  if (options.body instanceof FormData) init.body = options.body;
  else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${state.apiUrl}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `Request failed with HTTP ${response.status}`, response.status, data);
  return data;
}

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

function validateApiUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "";
    return url.origin;
  } catch { return ""; }
}

function displayName(documentRecord) {
  return documentRecord.product_name || documentRecord.trade_name || documentRecord.original_filename || "Unnamed SDS";
}

function formatDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function node(tag, properties = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key,value] of Object.entries(properties)) {
    if (key === "className") element.className = value;
    else if (key === "textContent") element.textContent = value;
    else element[key] = value;
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

function emptyState(message) { return node("div", { className:"empty-state", textContent:message }); }

function showToast(message) {
  clearTimeout(toastTimer);
  elements.adminToast.textContent = message;
  elements.adminToast.hidden = false;
  toastTimer = setTimeout(() => { elements.adminToast.hidden = true; }, 5000);
}

initialize();
