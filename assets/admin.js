const config = window.SDS_CONFIG || {};
const STATUSES = ["Uploaded","Parsing","Extracted","Needs Review","Approved","Rejected","Archived","Duplicate"];
const ARRAY_FIELDS = new Set(["cas_numbers","ghs_pictograms","hazard_statements","precautionary_statements","missing_fields"]);
const LONG_FIELDS = new Set(["recommended_use","ppe_recommendation","storage_summary","first_aid_summary","spill_response_summary","firefighting_summary","disposal_summary","review_required_reason"]);
const DATE_FIELDS = new Set(["issue_date","revision_date","preparation_date","print_date","effective_date","establishment_date","validity_date_basis"]);
const FIELD_DEFINITIONS = [
  ["is_likely_sds","Likely valid SDS","checkbox"],
  ["product_name","Formal product name","text"], ["trade_name","Trade name","text"],
  ["supplier","Supplier","text"], ["manufacturer","Manufacturer","text"], ["language","Language","text"],
  ["revision_date","Revision date","date"], ["issue_date","Issue date","date"],
  ["preparation_date","Preparation date","date"], ["establishment_date","Establishment date","date"],
  ["effective_date","Effective date","date"], ["print_date","Print date","date"],
  ["validity_date_basis","Validity date basis","date-basis"],
  ["cas_numbers","CAS numbers (one per line)","array"], ["signal_word","Signal word","text"],
  ["ghs_pictograms","GHS pictograms (one per line)","array"],
  ["hazard_statements","Hazard statements (one per line)","array"],
  ["precautionary_statements","Precautionary statements (one per line)","array"],
  ["recommended_use","Recommended use","long"], ["ppe_recommendation","PPE recommendation","long"],
  ["storage_summary","Storage summary","long"], ["first_aid_summary","First-aid summary","long"],
  ["spill_response_summary","Spill response summary","long"], ["firefighting_summary","Firefighting summary","long"],
  ["disposal_summary","Disposal summary","long"], ["extraction_confidence","Extraction confidence (0-100)","number"],
  ["missing_fields","Missing fields (one per line)","array"], ["possible_duplicate_flag","Possible duplicate","checkbox"],
  ["review_required_reason","Review-required reason","long"]
];
const DATE_BASIS_LABELS = {
  revision_date:"Revision date", issue_date:"Issue date", preparation_date:"Preparation date",
  establishment_date:"Establishment date", effective_date:"Effective date", print_date:"Print date (low confidence)"
};
const SECTION_TITLES = {
  1:"Identification",2:"Hazard identification",3:"Composition/ingredients",4:"First-aid measures",
  5:"Fire-fighting measures",6:"Accidental release",7:"Handling and storage",8:"Exposure controls/PPE",
  9:"Physical & chemical properties",10:"Stability and reactivity",11:"Toxicological information",
  12:"Ecological information",13:"Disposal considerations",14:"Transport information",
  15:"Regulatory information",16:"Other information"
};

const state = {
  apiUrl:String(config.adminApiUrl || "").replace(/\/$/, ""), supabase:null, session:null, profile:null,
  currentView:"dashboard", selectedId:"", selectedDocument:null, visibleDocuments:[], selectedIds:new Set(), bulkAction:""
};

const elementIds = [
  "connectionBadge","connectionPanel","workspace","adminSidebar","loginForm","emailInput","passwordInput","loginButton","loginError","logoutButton",
  "dashboardCards","recentTable","uploadForm","pdfInput","uploadButton","uploadProgress","uploadResult","queueTable","reviewList",
  "reviewForm","reviewStatus","reviewTitle","reviewOriginal","reviewWarnings","reviewFields","reviewComment",
  "openOriginalButton","saveReviewButton","reextractButton","duplicateButton","archiveButton","rejectButton","approveButton",
  "masterSearch","masterStatus","masterScope","masterSearchButton","masterTable","bulkToolbar","selectAllButton","clearSelectionButton",
  "selectedCount","bulkArchiveButton","bulkDeleteButton","bulkRestoreButton","bulkResult","bulkDialog","bulkForm","bulkDialogTitle",
  "bulkDialogMessage","bulkReason","bulkConfirmation","bulkCancelButton","bulkConfirmButton","duplicateTable","detailContent","detailNav","adminToast"
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));
let toastTimer;

async function initialize() {
  for (const status of STATUSES) elements.masterStatus.append(new Option(status, status));
  bindEvents();
  if (!state.apiUrl || !config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) {
    showLoginError("Supabase Auth public configuration is incomplete.");
    return;
  }
  state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:false }
  });
  state.supabase.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === "SIGNED_OUT") showLoggedOut();
  });
  const { data, error } = await state.supabase.auth.getSession();
  if (error) return showLoginError(error.message);
  if (data.session) await authorizeSession(data.session);
}

function bindEvents() {
  document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-refresh]").forEach((button) => button.addEventListener("click", () => refreshView(button.dataset.refresh)));
  elements.loginForm.addEventListener("submit", handleAsync(login));
  elements.logoutButton.addEventListener("click", handleAsync(logout));
  elements.uploadForm.addEventListener("submit", uploadDocument);
  elements.masterSearchButton.addEventListener("click", handleAsync(loadMaster));
  elements.masterScope.addEventListener("change", handleAsync(loadMaster));
  elements.openOriginalButton.addEventListener("click", () => openFile("original"));
  elements.saveReviewButton.addEventListener("click", handleAsync(saveReview));
  elements.reextractButton.addEventListener("click", handleAsync(reextract));
  elements.duplicateButton.addEventListener("click", handleAsync(markDuplicate));
  elements.archiveButton.addEventListener("click", handleAsync(() => statusAction("archive", "Archive this record?")));
  elements.rejectButton.addEventListener("click", handleAsync(() => statusAction("reject", "Reject this SDS intake record?")));
  elements.approveButton.addEventListener("click", handleAsync(approve));
  elements.selectAllButton.addEventListener("click", selectAllVisible);
  elements.clearSelectionButton.addEventListener("click", clearSelection);
  elements.bulkArchiveButton.addEventListener("click", () => openBulkDialog("archive"));
  elements.bulkDeleteButton.addEventListener("click", () => openBulkDialog("delete"));
  elements.bulkRestoreButton.addEventListener("click", () => openBulkDialog("restore"));
  elements.bulkCancelButton.addEventListener("click", () => elements.bulkDialog.close());
  elements.bulkForm.addEventListener("submit", handleAsync(submitBulkAction));
}

function handleAsync(action) {
  return (event) => Promise.resolve(action(event)).catch((error) => showToast(error?.message || "The request failed."));
}

async function login(event) {
  event?.preventDefault();
  hideLoginError();
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "Logging in...";
  const { data, error } = await state.supabase.auth.signInWithPassword({
    email:elements.emailInput.value.trim(), password:elements.passwordInput.value
  });
  try {
    if (error) throw error;
    await authorizeSession(data.session);
    elements.passwordInput.value = "";
  } catch (error) {
    showLoginError(error.message || "Login failed.");
  } finally {
    elements.loginButton.disabled = false;
    elements.loginButton.textContent = "Login";
  }
}

async function authorizeSession(session) {
  state.session = session;
  try {
    const data = await api("/v1/admin/session", {}, session.access_token);
    state.profile = data.user;
    showAuthorizedWorkspace();
    await showView("dashboard");
  } catch (error) {
    state.profile = null;
    elements.workspace.hidden = true;
    elements.adminSidebar.hidden = true;
    elements.connectionPanel.hidden = false;
    elements.logoutButton.hidden = false;
    elements.connectionBadge.textContent = session?.user?.email || "Signed in, not authorized";
    showLoginError(error.message);
  }
}

function showAuthorizedWorkspace() {
  const isAdmin = state.profile?.role === "EHS_ADMIN";
  document.querySelectorAll("[data-admin-only]").forEach((item) => { item.hidden = !isAdmin; });
  elements.connectionPanel.hidden = true;
  elements.workspace.hidden = false;
  elements.adminSidebar.hidden = false;
  elements.logoutButton.hidden = false;
  elements.connectionBadge.textContent = `${state.profile.display_name} · ${state.profile.role.replace("EHS_", "")}`;
  elements.connectionBadge.classList.add("is-connected");
  hideLoginError();
}

function showLoggedOut() {
  state.session = null; state.profile = null; state.selectedId = ""; state.selectedDocument = null;
  clearSelection();
  elements.workspace.hidden = true; elements.adminSidebar.hidden = true; elements.connectionPanel.hidden = false;
  elements.logoutButton.hidden = true; elements.connectionBadge.textContent = "Not logged in";
  elements.connectionBadge.classList.remove("is-connected");
}

async function logout() {
  await state.supabase.auth.signOut({ scope:"local" });
  showLoggedOut();
}

function showLoginError(message) { elements.loginError.textContent = message; elements.loginError.hidden = false; }
function hideLoginError() { elements.loginError.hidden = true; elements.loginError.textContent = ""; }
function isAdmin() { return state.profile?.role === "EHS_ADMIN"; }

async function showView(view) {
  if (!state.profile || (view === "upload" && !isAdmin()) || (view === "detail" && !state.selectedId)) return;
  state.currentView = view;
  document.querySelectorAll(".admin-view").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active; panel.classList.toggle("is-active", active);
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
  } catch (error) { showToast(error.message); }
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
  if (!documents.length) { elements.reviewList.replaceChildren(emptyState("No documents currently need EHS review.")); elements.reviewForm.hidden = true; return; }
  elements.reviewList.replaceChildren(...documents.map((record) => {
    const button = node("button", { className:"review-item", type:"button" }, [
      node("strong", { textContent:displayName(record) }),
      node("span", { textContent:`${record.original_filename} · ${record.extraction_confidence || 0}% confidence` })
    ]);
    button.classList.toggle("is-active", record.id === state.selectedId);
    button.addEventListener("click", () => openReview(record.id));
    return button;
  }));
  if (!state.selectedId || !documents.some((item) => item.id === state.selectedId)) await openReview(documents[0].id);
}

async function openReview(documentId) {
  const data = await api(`/v1/admin/documents/${documentId}`);
  state.selectedId = documentId; state.selectedDocument = data.document; elements.detailNav.disabled = false;
  renderReviewForm(data.document); elements.reviewForm.hidden = false;
}

function renderReviewForm(record) {
  elements.reviewStatus.textContent = record.status; elements.reviewStatus.dataset.status = record.status;
  elements.reviewTitle.textContent = displayName(record); elements.reviewOriginal.textContent = `Original: ${record.original_filename}`;
  const warnings = [
    record.ocr_required ? "PDF text was weak or image-only. OCR or visual verification is required." : "",
    record.possible_duplicate_flag ? `Possible duplicate${record.duplicate_of_id ? ` of ${record.duplicate_of_id}` : ""}.` : "",
    ...(Array.isArray(record.date_detection_warnings) ? record.date_detection_warnings : []), record.review_required_reason || ""
  ].filter(Boolean);
  elements.reviewWarnings.hidden = !warnings.length; elements.reviewWarnings.textContent = [...new Set(warnings)].join("\n");
  elements.reviewFields.replaceChildren(buildValiditySummary(record), ...FIELD_DEFINITIONS.map(([field,label,type]) => createField(field,label,type,record[field])));
  elements.reviewComment.value = "";
}

function buildValiditySummary(record) {
  const found = Array.isArray(record.sections_found) ? record.sections_found : [];
  const missing = Array.isArray(record.missing_sections) ? record.missing_sections : [];
  const missingText = missing.length ? missing.map((section) => `${section} (${SECTION_TITLES[section] || "?"})`).join(", ") : "None — all 16 present";
  const card = node("div", { className:"field-wide review-summary" });
  card.append(node("span", { className:"review-summary-title", textContent:"SDS dates, validity & 16-section completeness" }));
  const grid = node("div", { className:"review-summary-grid" });
  grid.append(
    summaryRow("Revision date", record.revision_date || "Not detected"), summaryRow("Issue date", record.issue_date || "Not detected"),
    summaryRow("Preparation date", record.preparation_date || "Not detected"), summaryRow("Establishment date", record.establishment_date || "Not detected"),
    summaryRow("Effective date", record.effective_date || "Not detected"), summaryRow("Print date", record.print_date || "Not detected", record.validity_date_basis === "print_date"),
    summaryRow("Validity basis", DATE_BASIS_LABELS[record.validity_date_basis] || "Not established", !record.validity_date_basis || record.validity_date_basis === "print_date"),
    summaryRow("Validity date", record.validity_date_value || record.established_date || "Not established", !record.validity_date_value),
    summaryRow("Date confidence", `${record.detected_date_confidence || 0}%`, (record.detected_date_confidence || 0) < 70),
    summaryRow("Detected source", record.detected_date_source || "Not detected"),
    summaryRow("Sections found", `${found.length} of 16 · ${record.section_detection_confidence || 0}%`, found.length < 16),
    summaryRow("Missing sections", missingText, missing.length > 0)
  );
  card.append(grid); return card;
}

function summaryRow(label, value, danger = false) {
  return node("div", { className:`review-summary-row${danger ? " is-danger" : ""}` }, [
    node("span", { className:"review-summary-label", textContent:label }), node("span", { className:"review-summary-value", textContent:String(value) })
  ]);
}

function createField(field, labelText, type, value) {
  const label = node("label", { className:LONG_FIELDS.has(field) || ARRAY_FIELDS.has(field) ? "field-wide" : "" });
  label.append(node("span", { textContent:labelText }));
  let input;
  if (type === "checkbox") { input = node("input", { type:"checkbox" }); input.checked = Boolean(value); }
  else if (type === "date-basis") {
    input = node("select"); input.append(new Option("Select validity basis", ""));
    Object.entries(DATE_BASIS_LABELS).forEach(([basis,text]) => input.append(new Option(text,basis)));
    input.value = value || "";
  } else if (type === "long" || type === "array") {
    input = node("textarea", { rows:type === "array" ? 4 : 3 }); input.value = type === "array" ? (value || []).join("\n") : value || "";
  } else {
    input = node("input", { type:type === "number" ? "number" : type === "date" ? "date" : "text" }); input.value = value ?? "";
    if (type === "number") { input.min = "0"; input.max = "100"; }
  }
  input.dataset.field = field;
  if (DATE_FIELDS.has(field) && !isAdmin()) { input.disabled = true; input.title = "Only EHS_ADMIN can correct SDS dates."; }
  label.append(input); return label;
}

function collectReviewMetadata() {
  const metadata = {};
  elements.reviewFields.querySelectorAll("[data-field]").forEach((input) => {
    const field = input.dataset.field;
    if (input.disabled) return;
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
  if (!isAdmin() || !confirm("Approve this metadata and create the controlled filename?")) return;
  const payload = { metadata:collectReviewMetadata(), comment:elements.reviewComment.value };
  try {
    const data = await api(`/v1/admin/documents/${state.selectedId}/approve`, { method:"POST", body:payload });
    await finishApproval(data);
  } catch (error) {
    if (error.status === 409 && error.data?.requires_print_date_confirmation && confirm("Only the print date is available. Use it as a low-confidence validity basis and approve?")) {
      payload.confirmPrintDate = true;
      await finishApproval(await api(`/v1/admin/documents/${state.selectedId}/approve`, { method:"POST", body:payload }));
      return;
    }
    throw error;
  }
}

async function finishApproval(data) {
  showToast(`Approved as ${data.approved_filename}`); state.selectedDocument = data.document;
  elements.reviewForm.hidden = true; state.selectedId = ""; await loadReviewList();
}

async function reextract() {
  if (!confirm("Request a fresh extraction using the original PDF?")) return;
  await documentAction("extract", "POST", { forceGemini:true, comment:elements.reviewComment.value });
  showToast("Re-extraction completed and returned to review.");
}

async function markDuplicate() {
  if (!isAdmin()) return;
  const duplicateOfId = prompt("Enter the controlling document ID:");
  if (!duplicateOfId) return;
  await documentAction("duplicate", "POST", { duplicate_of_id:duplicateOfId.trim(), comment:elements.reviewComment.value });
  showToast("Document marked as duplicate."); state.selectedId = ""; await loadReviewList();
}

async function statusAction(action, question) {
  if (!isAdmin() || !confirm(question)) return;
  await documentAction(action, "POST", { comment:elements.reviewComment.value });
  showToast(action === "reject" ? "Record rejected." : "Record archived."); state.selectedId = ""; await loadReviewList();
}

async function documentAction(action, method, data) {
  if (!state.selectedId) throw new Error("Select a document first.");
  const path = `/v1/admin/documents/${state.selectedId}${action ? `/${action}` : ""}`;
  const result = await api(path, { method, body:data }); state.selectedDocument = result.document;
  if (result.document?.status === "Needs Review") renderReviewForm(result.document);
  return result;
}

async function loadMaster() {
  const params = new URLSearchParams({ limit:"200", scope:isAdmin() ? elements.masterScope.value : "active" });
  if (elements.masterStatus.value) params.set("status", elements.masterStatus.value);
  if (elements.masterSearch.value.trim()) params.set("q", elements.masterSearch.value.trim());
  const data = await api(`/v1/admin/documents?${params}`);
  state.visibleDocuments = data.documents || []; clearSelection();
  renderDocumentTable(elements.masterTable, state.visibleDocuments, { selectable:isAdmin() });
}

async function loadDuplicates() { const data = await api("/v1/admin/duplicates"); renderDocumentTable(elements.duplicateTable, data.documents || []); }

function renderDocumentTable(container, documents, { compact = false, selectable = false } = {}) {
  if (!documents.length) return container.replaceChildren(emptyState("No matching SDS records."));
  const table = node("table", { className:"data-table" }); const head = node("thead"); const headerRow = node("tr");
  if (selectable) headerRow.append(node("th", { textContent:"Select" }));
  for (const title of compact ? ["Document","Status","Updated","Action"] : ["Document","Original filename","Status","Confidence","Updated","Action"]) headerRow.append(node("th", { textContent:title }));
  head.append(headerRow); const body = node("tbody");
  for (const record of documents) {
    const row = node("tr");
    if (selectable) {
      const checkbox = node("input", { type:"checkbox" }); checkbox.checked = state.selectedIds.has(record.id);
      checkbox.setAttribute("aria-label", `Select ${displayName(record)}`);
      checkbox.addEventListener("change", () => { checkbox.checked ? state.selectedIds.add(record.id) : state.selectedIds.delete(record.id); updateSelectedCount(); });
      const cell = node("td"); cell.append(checkbox); row.append(cell);
    }
    row.append(node("td", { textContent:displayName(record) }));
    if (!compact) row.append(node("td", { textContent:record.original_filename || "-" }));
    const statusCell = node("td"); const badge = node("span", { className:"status-badge", textContent:record.deleted_at ? "Deleted" : record.status });
    badge.dataset.status = record.deleted_at ? "Deleted" : record.status; statusCell.append(badge); row.append(statusCell);
    if (!compact) row.append(node("td", { textContent:`${record.extraction_confidence || 0}%` }));
    row.append(node("td", { textContent:formatDateTime(record.updated_at) }));
    const actionCell = node("td"); const button = node("button", { type:"button", textContent:record.status === "Needs Review" && !record.deleted_at ? "Review" : "View" });
    button.addEventListener("click", () => record.status === "Needs Review" && !record.deleted_at ? (showView("review"), openReview(record.id)) : openDetail(record.id));
    actionCell.append(button); row.append(actionCell); body.append(row);
  }
  table.append(head, body); container.replaceChildren(table);
}

function selectAllVisible() { state.visibleDocuments.forEach((record) => state.selectedIds.add(record.id)); syncMasterCheckboxes(); }
function clearSelection() { state.selectedIds.clear(); syncMasterCheckboxes(); }
function syncMasterCheckboxes() { elements.masterTable?.querySelectorAll('input[type="checkbox"]').forEach((input, index) => { input.checked = state.selectedIds.has(state.visibleDocuments[index]?.id); }); updateSelectedCount(); }
function updateSelectedCount() { if (elements.selectedCount) elements.selectedCount.textContent = `${state.selectedIds.size} selected`; }

function openBulkDialog(action) {
  if (!state.selectedIds.size) return showToast("Select at least one SDS record first.");
  state.bulkAction = action;
  const word = action.toUpperCase();
  const impact = action === "restore" ? "Records will return to the controlled register." : "Affected approved SDS records will no longer appear in the public catalog or search/QR results.";
  elements.bulkDialogTitle.textContent = `Confirm bulk ${action}`;
  elements.bulkDialogMessage.textContent = `${state.selectedIds.size} SDS record(s) will be ${action === "delete" ? "soft-deleted" : action + "d"}. ${impact} The action and your identity will be recorded in the audit trail. Type ${word} below.`;
  elements.bulkReason.value = ""; elements.bulkConfirmation.value = ""; elements.bulkConfirmButton.textContent = `Confirm ${word}`;
  elements.bulkDialog.showModal();
}

async function submitBulkAction(event) {
  event?.preventDefault();
  const action = state.bulkAction; const confirmation = elements.bulkConfirmation.value.trim(); const reason = elements.bulkReason.value.trim();
  if (!reason || confirmation !== action.toUpperCase()) throw new Error(`Reason is required and confirmation must be ${action.toUpperCase()}.`);
  elements.bulkConfirmButton.disabled = true;
  try {
    const data = await api(`/v1/admin/documents/bulk/${action}`, { method:"POST", body:{ ids:[...state.selectedIds], confirmation, reason } });
    elements.bulkDialog.close(); renderBulkResult(data);
    if (state.currentView === "detail" && state.selectedId) await loadDetail(state.selectedId);
    else await loadMaster();
  } finally { elements.bulkConfirmButton.disabled = false; }
}

function renderBulkResult(data) {
  elements.bulkResult.hidden = false;
  elements.bulkResult.replaceChildren(node("strong", { textContent:`${data.total_selected} selected · ${data.succeeded} succeeded · ${data.skipped} skipped · ${data.failed} failed` }));
  const exceptions = (data.results || []).filter((item) => item.status !== "success");
  if (exceptions.length) elements.bulkResult.append(node("ul", {}, exceptions.map((item) => node("li", { textContent:`${item.id}: ${item.status} — ${item.reason || "No reason returned"}` }))));
}

async function openDetail(documentId) { state.selectedId = documentId; elements.detailNav.disabled = false; await showView("detail"); }

async function loadDetail(documentId) {
  const data = await api(`/v1/admin/documents/${documentId}`); const record = data.document;
  const summary = node("section", { className:"detail-card" }); summary.append(node("h2", { textContent:displayName(record) }));
  const list = node("dl", { className:"definition-list" });
  const fields = ["status","original_filename","approved_filename","product_name","trade_name","supplier","manufacturer","language","revision_date","issue_date","preparation_date","establishment_date","effective_date","print_date","validity_date_basis","validity_date_value","detected_date_source","detected_date_confidence","established_date","expiry_date","signal_word","extraction_confidence","extraction_method","ocr_required","possible_duplicate_flag","archived_at","archive_reason","deleted_at","delete_reason","review_required_reason"];
  for (const field of fields) list.append(node("dt", { textContent:field.replaceAll("_"," ") }), node("dd", { textContent:String(record[field] ?? "-") }));
  const missing = Array.isArray(record.missing_sections) ? record.missing_sections : [];
  list.append(node("dt", { textContent:"missing sections" }), node("dd", { textContent:missing.length ? missing.join(", ") : "None — all 16 present" })); summary.append(list);
  if (isAdmin() && (record.deleted_at || record.archived_at)) {
    const restore = node("button", { className:"secondary-action", type:"button", textContent:"Restore record" });
    restore.addEventListener("click", () => { state.selectedIds = new Set([record.id]); openBulkDialog("restore"); }); summary.append(restore);
  }
  const audit = node("section", { className:"detail-card" }); audit.append(node("h2", { textContent:"Audit trail" })); const timeline = node("div", { className:"timeline" });
  for (const item of data.audit_events || data.review_history || []) timeline.append(node("div", { className:"timeline-item" }, [
    node("strong", { textContent:`${item.action} · ${item.display_name || item.reviewer} · ${item.role || item.reviewer_role || ""}` }),
    node("span", { textContent:formatDateTime(item.created_at) }), item.reason || item.comment ? node("span", { textContent:item.reason || item.comment }) : null
  ].filter(Boolean)));
  audit.append(timeline.children.length ? timeline : emptyState("No audit events.")); elements.detailContent.replaceChildren(node("div", { className:"detail-grid" }, [summary,audit]));
}

async function uploadDocument(event) {
  event.preventDefault(); const file = elements.pdfInput.files[0]; if (!file) return showToast("Select a PDF or ZIP first.");
  const isZip = /\.zip$/i.test(file.name); const form = new FormData(); form.append("file", file, file.name);
  elements.uploadButton.disabled = true; elements.uploadButton.textContent = isZip ? "Processing ZIP batch..." : "Uploading and extracting...";
  elements.uploadProgress.hidden = false; elements.uploadProgress.textContent = isZip ? "Uploading ZIP → extracting PDFs → processing intake records…" : "Uploading PDF → extracting SDS metadata…";
  elements.uploadResult.hidden = true; elements.uploadResult.replaceChildren();
  try {
    const result = await api("/v1/admin/documents", { method:"POST", body:form });
    elements.uploadProgress.textContent = "Completed"; elements.uploadResult.hidden = false;
    if (result.batch) renderZipResult(result); else {
      elements.uploadResult.textContent = `${result.document.original_filename} uploaded. Status: ${result.document.status}. Confidence: ${result.document.extraction_confidence || 0}%.`;
      state.selectedId = result.document.id; elements.detailNav.disabled = false;
    }
    elements.uploadForm.reset();
  } catch (error) { elements.uploadProgress.textContent = "Failed"; showToast(error.message); }
  finally { elements.uploadButton.disabled = false; elements.uploadButton.textContent = "Upload and extract"; }
}

function renderZipResult(result) {
  const batch = result.batch; elements.uploadResult.append(node("strong", { textContent:`Batch ${batch.status}: ${batch.accepted_pdf_count} accepted, ${batch.duplicate_count} duplicate, ${batch.rejected_file_count} rejected, ${batch.failed_count} failed.` }));
  const table = node("table", { className:"data-table upload-results-table" });
  const head = node("thead"); head.append(node("tr", {}, ["Filename","Status","Product","Manufacturer","Date / basis","Sections","Reason"].map((title) => node("th", { textContent:title }))));
  const body = node("tbody");
  for (const item of result.results || []) body.append(node("tr", {}, [
    item.filename, item.status, item.product_name || "-", item.manufacturer || "-",
    item.date_detected ? `${item.date_detected} / ${item.date_basis_used || "unknown"}` : "-",
    item.sections_complete === true ? "16/16" : Array.isArray(item.missing_sections) ? `Missing ${item.missing_sections.join(", ")}` : "-", item.reason || "-"
  ].map((value) => node("td", { textContent:String(value) }))));
  table.append(head, body); elements.uploadResult.append(table);
}

async function openFile(variant) {
  if (!state.selectedId) return;
  try {
    const token = await accessToken();
    const response = await fetch(`${state.apiUrl}/v1/admin/documents/${state.selectedId}/file?variant=${encodeURIComponent(variant)}`, { headers:{ Authorization:`Bearer ${token}` } });
    if (!response.ok) throw new Error("PDF could not be opened.");
    const url = URL.createObjectURL(await response.blob()); window.open(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { showToast(error.message); }
}

async function accessToken() {
  const { data, error } = await state.supabase.auth.getSession();
  if (error || !data.session?.access_token) { showLoggedOut(); throw new Error("Session expired. Please log in again."); }
  state.session = data.session; return data.session.access_token;
}

async function api(path, options = {}, suppliedToken = "") {
  const token = suppliedToken || await accessToken();
  const headers = { Authorization:`Bearer ${token}`, Accept:"application/json" }; const init = { method:options.method || "GET", headers };
  if (options.body instanceof FormData) init.body = options.body;
  else if (options.body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
  const response = await fetch(`${state.apiUrl}${path}`, init); const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) { await state.supabase.auth.signOut({ scope:"local" }).catch(() => {}); showLoggedOut(); showLoginError(data.error || "Session expired. Please log in again."); }
    throw new ApiError(data.error || `Request failed with HTTP ${response.status}`, response.status, data);
  }
  return data;
}

class ApiError extends Error { constructor(message, status, data) { super(message); this.status = status; this.data = data; } }
function displayName(record) { return record.product_name || record.trade_name || record.original_filename || "Unnamed SDS"; }
function formatDateTime(value) { if (!value) return "-"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(); }
function node(tag, properties = {}, children = []) { const element = document.createElement(tag); for (const [key,value] of Object.entries(properties)) { if (key === "className") element.className = value; else if (key === "textContent") element.textContent = value; else element[key] = value; } for (const child of children) if (child) element.append(child); return element; }
function emptyState(message) { return node("div", { className:"empty-state", textContent:message }); }
function showToast(message) { clearTimeout(toastTimer); elements.adminToast.textContent = message; elements.adminToast.hidden = false; toastTimer = setTimeout(() => { elements.adminToast.hidden = true; }, 6000); }

initialize().catch((error) => showLoginError(error.message || "Admin initialization failed."));
