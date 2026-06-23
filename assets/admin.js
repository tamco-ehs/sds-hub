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
const REVIEW_DECISION_LABELS = {
  no_review_required_existing_unchanged:"Existing approved SDS — unchanged",
  auto_prescreen_pass:"Pre-screen passed — approval only",
  quick_check_required:"Quick EHS check",
  full_review_required:"Full EHS review",
  ocr_review_required:"OCR / visual review",
  conflict_duplicate:"Duplicate / conflict review",
  not_sds_or_replace_file:"Not SDS / replace file",
  error_needs_review:"Processing error"
};
const REVIEW_DECISION_ORDER = [
  "error_needs_review","not_sds_or_replace_file","ocr_review_required","conflict_duplicate",
  "full_review_required","quick_check_required","auto_prescreen_pass","no_review_required_existing_unchanged"
];
const SECTION_TITLES = {
  1:"Identification",2:"Hazard identification",3:"Composition/ingredients",4:"First-aid measures",
  5:"Fire-fighting measures",6:"Accidental release",7:"Handling and storage",8:"Exposure controls/PPE",
  9:"Physical & chemical properties",10:"Stability and reactivity",11:"Toxicological information",
  12:"Ecological information",13:"Disposal considerations",14:"Transport information",
  15:"Regulatory information",16:"Other information"
};
const LANG_LABELS = { en:"English", ms:"Bahasa Melayu", bilingual:"Bilingual (EN/BM)", unknown:"Unknown" };
const GROUP_STATUS_LABELS = {
  unlinked:"Not grouped", suggested:"Possible language variant — needs EHS decision",
  linked:"Linked as a language variant", separate:"Kept as a separate SDS"
};
// Ordered buckets for grouping the review reasons; each reason lands in the first category it matches.
const REVIEW_CATEGORIES = [
  ["Identity", /product\s*name|trade\s*name|\bidentity\b|not\s+sds|replace file/i],
  ["Supplier / manufacturer", /supplier|manufacturer|pembekal/i],
  ["Date & revision", /\bdate\b|revision|issued?|preparation|prepared|expir|supersed|ambiguous|validity|month precision|2-?digit/i],
  ["Section completeness", /section|incomplete|of 16/i],
  ["SDS format", /legacy|msds|non-?standard|standard.*order|format|alignment/i],
  ["Hazard severity", /hazard|signal word|\bdanger\b|toxic|corros|flammable|oxidi|explos|carcinogen|mutagen|high-risk|high-consequence/i],
  ["Language variant", /language variant|bilingual|english version|bahasa melayu version/i],
  ["Duplicate", /duplicate/i],
  ["AI / OCR status", /\bai\b|ocr|gemini|rule-based|assistance|scanned|image-only/i],
  ["EHS action", /approval|ehs|publication|confirm|before publication/i]
];

const state = {
  apiUrl:String(config.adminApiUrl || "").replace(/\/$/, ""), supabase:null, session:null, profile:null,
  currentView:"dashboard", selectedId:"", selectedDocument:null, selectedGroup:null, visibleDocuments:[], selectedIds:new Set(), bulkAction:""
};

const elementIds = [
  "connectionBadge","connectionPanel","workspace","adminSidebar","loginForm","emailInput","passwordInput","loginButton","loginError","loginNotice","forgotPasswordButton","logoutButton",
  "changePasswordButton","passwordDialog","passwordForm","passwordDialogTitle","newPasswordInput","confirmPasswordInput","passwordError","passwordCancelButton","passwordSaveButton",
  "dashboardCards","recentTable","uploadForm","pdfInput","uploadButton","uploadProgress","uploadResult","uploadStepper","queueTable","reviewList",
  "reviewForm","reviewStatus","reviewTitle","reviewOriginal","reviewWarnings","reviewFields","reviewComment",
  "openOriginalButton","saveReviewButton","reextractButton","duplicateButton","archiveButton","rejectButton","approveButton",
  "masterSearch","masterStatus","masterScope","masterSearchButton","masterTable","bulkToolbar","selectAllButton","clearSelectionButton",
  "selectedCount","bulkArchiveButton","bulkDeleteButton","bulkPurgeButton","bulkRestoreButton","bulkResult","bulkDialog","bulkForm","bulkDialogTitle",
  "bulkDialogMessage","bulkReason","bulkConfirmation","bulkCancelButton","bulkConfirmButton","duplicateTable","detailContent","detailNav","adminToast",
  "duplicateDialog","duplicateMessage","duplicateExisting","duplicateCancelButton","duplicateMarkButton","duplicateRevisionButton"
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
    auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
  });
  const passwordSetupRequired = /(?:type=invite|type=recovery)/i.test(`${location.search}${location.hash}`);
  state.supabase.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === "SIGNED_OUT") showLoggedOut();
    if (session && passwordSetupRequired && ["SIGNED_IN","PASSWORD_RECOVERY","INITIAL_SESSION"].includes(event) && !elements.passwordDialog.open) showPasswordDialog(true);
  });
  const { data, error } = await state.supabase.auth.getSession();
  if (error) return showLoginError(error.message);
  if (data.session) {
    if (passwordSetupRequired) { if (!elements.passwordDialog.open) showPasswordDialog(true); }
    else await authorizeSession(data.session);
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-refresh]").forEach((button) => button.addEventListener("click", () => refreshView(button.dataset.refresh)));
  elements.loginForm.addEventListener("submit", handleAsync(login));
  elements.logoutButton.addEventListener("click", handleAsync(logout));
  elements.changePasswordButton.addEventListener("click", () => showPasswordDialog(false));
  elements.passwordCancelButton.addEventListener("click", () => elements.passwordDialog.close());
  elements.passwordForm.addEventListener("submit", handleAsync(savePassword));
  elements.forgotPasswordButton.addEventListener("click", handleAsync(forgotPassword));
  elements.uploadForm.addEventListener("submit", uploadDocument);
  elements.duplicateCancelButton.addEventListener("click", () => elements.duplicateDialog.close());
  elements.duplicateMarkButton.addEventListener("click", handleAsync(confirmDuplicateAsDuplicate));
  elements.duplicateRevisionButton.addEventListener("click", handleAsync(confirmUploadAsNewRevision));
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
  elements.bulkPurgeButton.addEventListener("click", () => openBulkDialog("purge"));
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
  elements.changePasswordButton.hidden = false;
  elements.connectionBadge.textContent = `${state.profile.display_name} · ${state.profile.role.replace("EHS_", "")}`;
  elements.connectionBadge.classList.add("is-connected");
  hideLoginError();
}

function showLoggedOut() {
  state.session = null; state.profile = null; state.selectedId = ""; state.selectedDocument = null;
  clearSelection();
  elements.workspace.hidden = true; elements.adminSidebar.hidden = true; elements.connectionPanel.hidden = false;
  elements.logoutButton.hidden = true; elements.changePasswordButton.hidden = true; elements.connectionBadge.textContent = "Not logged in";
  elements.connectionBadge.classList.remove("is-connected");
}

async function logout() {
  await state.supabase.auth.signOut({ scope:"local" });
  showLoggedOut();
}

function showPasswordDialog(required) {
  elements.passwordDialogTitle.textContent = required ? "Create your administrator password" : "Change your password";
  elements.passwordCancelButton.hidden = Boolean(required);
  elements.newPasswordInput.value = ""; elements.confirmPasswordInput.value = "";
  elements.passwordError.hidden = true; elements.passwordError.textContent = "";
  elements.passwordDialog.showModal();
}

async function savePassword(event) {
  event?.preventDefault();
  const password = elements.newPasswordInput.value;
  if (password.length < 12) return showPasswordError("Use at least 12 characters.");
  if (password !== elements.confirmPasswordInput.value) return showPasswordError("The passwords do not match.");
  elements.passwordSaveButton.disabled = true;
  try {
    const { data, error } = await state.supabase.auth.updateUser({ password });
    if (error) throw error;
    elements.passwordDialog.close();
    history.replaceState(null, "", `${location.pathname}${location.search && !/type=/i.test(location.search) ? location.search : ""}`);
    showToast("Password saved.");
    if (!state.profile) {
      const { data:sessionData } = await state.supabase.auth.getSession();
      if (sessionData.session) await authorizeSession(sessionData.session);
    }
    return data;
  } catch (error) { showPasswordError(error.message || "Password could not be updated."); }
  finally { elements.passwordSaveButton.disabled = false; }
}

function showPasswordError(message) { elements.passwordError.textContent = message; elements.passwordError.hidden = false; }

function showLoginError(message) { if (elements.loginNotice) elements.loginNotice.hidden = true; elements.loginError.textContent = message; elements.loginError.hidden = false; }
function hideLoginError() { elements.loginError.hidden = true; elements.loginError.textContent = ""; }
function showLoginNotice(message) { elements.loginError.hidden = true; elements.loginNotice.textContent = message; elements.loginNotice.hidden = false; }
function isAdmin() { return state.profile?.role === "EHS_ADMIN"; }

// Supabase emails a recovery link to reset-password.html. The message is identical whether or not the email exists.
async function forgotPassword() {
  const email = elements.emailInput.value.trim();
  if (!email) return showLoginError("Enter your email above, then choose “Forgot password?”.");
  elements.forgotPasswordButton.disabled = true;
  try {
    const redirectTo = new URL("reset-password.html", location.href).href;
    await state.supabase.auth.resetPasswordForEmail(email, { redirectTo });
  } catch (error) {
    console.warn("Password reset request failed:", error?.message || error);
  } finally {
    elements.forgotPasswordButton.disabled = false;
  }
  showLoginNotice("If that email is registered, a password reset link is on its way. Check your inbox and spam folder.");
}

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
  const grouped = new Map();
  documents.forEach((record) => {
    const decision = REVIEW_DECISION_LABELS[record.review_decision] ? record.review_decision : "full_review_required";
    if (!grouped.has(decision)) grouped.set(decision, []);
    grouped.get(decision).push(record);
  });
  const groups = REVIEW_DECISION_ORDER.filter((decision) => grouped.has(decision)).map((decision) => {
    const records = grouped.get(decision);
    const section = node("section", { className:`review-group review-group-${decision}` });
    section.append(node("div", { className:"review-group-heading" }, [
      node("strong", { textContent:REVIEW_DECISION_LABELS[decision] }),
      node("span", { textContent:String(records.length) })
    ]));
    records.forEach((record) => {
      const risk = String(record.risk_level || "unknown").toUpperCase();
      const company = record.manufacturer || record.supplier || "Manufacturer not detected";
      const button = node("button", { className:"review-item", type:"button" }, [
        node("strong", { textContent:displayName(record) }),
        node("span", { textContent:`${company} · ${record.extraction_confidence || 0}% confidence · ${risk} risk` }),
        node("span", { textContent:`${record.original_filename} · AI: ${formatCodeLabel(record.ai_verification_status || "not recorded")}` })
      ]);
      button.classList.toggle("is-active", record.id === state.selectedId);
      button.addEventListener("click", () => openReview(record.id));
      section.append(button);
    });
    return section;
  });
  elements.reviewList.replaceChildren(...groups);
  if (!state.selectedId || !documents.some((item) => item.id === state.selectedId)) await openReview(documents[0].id);
}

async function openReview(documentId) {
  const data = await api(`/v1/admin/documents/${documentId}`);
  state.selectedId = documentId; state.selectedDocument = data.document; state.selectedGroup = data.group || null; elements.detailNav.disabled = false;
  renderReviewForm(data.document); elements.reviewForm.hidden = false;
}

function renderReviewForm(record) {
  elements.reviewStatus.textContent = record.status; elements.reviewStatus.dataset.status = record.status;
  elements.reviewTitle.textContent = displayName(record); elements.reviewOriginal.textContent = `Original: ${record.original_filename}`;
  renderReviewWarnings(record);
  const evidence = buildEvidenceSummary(record.evidence_snippets);
  const grouping = buildGroupingCard(record, state.selectedGroup);
  elements.reviewFields.replaceChildren(buildValiditySummary(record), ...(grouping ? [grouping] : []), ...(evidence ? [evidence] : []), ...FIELD_DEFINITIONS.map(([field,label,type]) => createField(field,label,type,record[field])));
  elements.reviewComment.value = "";
}

// Group the review reasons into labelled categories so the same issue never shows twice and the
// reviewer can scan by concern. review_required_reason (the joined summary) is only a fallback.
function renderReviewWarnings(record) {
  const reasons = [...new Set([
    record.ocr_required ? "PDF text was weak or image-only; OCR or visual verification is required." : "",
    record.possible_duplicate_flag ? `Possible duplicate${record.duplicate_of_id ? ` of ${record.duplicate_of_id}` : ""}.` : "",
    ...(Array.isArray(record.review_reasons) ? record.review_reasons : []),
    ...(Array.isArray(record.extraction_conflicts) ? record.extraction_conflicts : []),
    ...(Array.isArray(record.date_detection_warnings) ? record.date_detection_warnings : []),
    ...((!Array.isArray(record.review_reasons) || !record.review_reasons.length) && record.review_required_reason ? String(record.review_required_reason).split(/\.\s+/) : [])
  ].map((reason) => String(reason).trim()).filter(Boolean))];

  elements.reviewWarnings.replaceChildren();
  elements.reviewWarnings.hidden = reasons.length === 0;
  if (!reasons.length) return;

  const buckets = new Map();
  for (const reason of reasons) {
    const category = (REVIEW_CATEGORIES.find(([, pattern]) => pattern.test(reason)) || ["Other"])[0];
    if (!buckets.has(category)) buckets.set(category, []);
    if (!buckets.get(category).includes(reason)) buckets.get(category).push(reason);
  }
  for (const [category] of [...REVIEW_CATEGORIES, ["Other"]]) {
    const items = buckets.get(category);
    if (!items || !items.length) continue;
    const group = node("div", { className:"review-issue-group" });
    group.append(node("span", { className:"review-issue-category", textContent:category }));
    const list = node("ul", { className:"review-issue-list" });
    for (const item of items) list.append(node("li", { textContent:item }));
    group.append(list);
    elements.reviewWarnings.append(group);
  }
}

// EHS language-variant grouping: detected language, a possible-variant suggestion with side-by-side
// comparison and link/separate actions, or the canonical record this document is already linked to.
function buildGroupingCard(record, group) {
  if (!group) return null;
  const langLabel = LANG_LABELS[group.document_language] || "Unknown";
  const card = node("div", { className:"field-wide review-summary grouping-card" });
  card.append(node("span", { className:"review-summary-title", textContent:"SDS language & variant grouping" }));
  const grid = node("div", { className:"review-summary-grid" });
  grid.append(
    summaryRow("Detected language", `${langLabel}${group.is_bilingual ? " · bilingual" : ""} · ${group.language_confidence ?? 0}%`),
    summaryRow("Grouping status", GROUP_STATUS_LABELS[group.language_variant_status] || "Not grouped", group.language_variant_status === "suggested")
  );
  if (group.language_detection_reason) grid.append(summaryRow("Language signals", group.language_detection_reason));
  card.append(grid);

  if (group.suggested_candidate) {
    card.append(node("p", { className:"grouping-hint", textContent:`This looks like a ${langLabel} language variant of an existing SDS. Confirm to group them under one product record, or keep it separate. Nothing is published to employees until you approve it.` }));
    card.append(buildVariantCompare(record, group.suggested_candidate));
    if (isAdmin()) {
      const linkBtn = node("button", { type:"button", className:"primary-action", textContent:"Link as language variant", onclick:() => groupAsVariant(group.suggested_candidate.id) });
      const sepBtn = node("button", { type:"button", className:"secondary-action", textContent:"Keep separate", onclick:() => keepSeparate() });
      card.append(node("div", { className:"grouping-actions" }, [linkBtn, sepBtn]));
    }
  }

  if (group.record) {
    card.append(node("p", { className:"grouping-hint", textContent:`Grouped under product record: ${group.record.canonical_product_name}` }));
    const list = node("ul", { className:"variant-list" });
    for (const variant of (group.linked_variants || [])) {
      const tags = `${LANG_LABELS[variant.document_language] || "?"} · ${variant.status}${variant.approved_for_employee_view ? " · visible to employees" : ""}${variant.revision_date ? ` · rev ${variant.revision_date}` : ""}`;
      list.append(node("li", {}, [ node("strong", { textContent:displayName(variant) }), node("span", { textContent:` — ${tags}` }) ]));
    }
    card.append(list);
    if (isAdmin()) card.append(node("div", { className:"grouping-actions" }, [
      node("button", { type:"button", className:"secondary-action", textContent:"Unlink from this group", onclick:() => keepSeparate() })
    ]));
  }
  return card;
}

function buildVariantCompare(record, candidate) {
  const table = node("table", { className:"variant-compare" });
  table.append(node("tr", {}, [ node("th",{textContent:""}), node("th",{textContent:"Uploaded SDS"}), node("th",{textContent:"Existing SDS"}) ]));
  const rows = [
    ["Product", displayName(record), displayName(candidate)],
    ["Language", LANG_LABELS[record.document_language] || "?", LANG_LABELS[candidate.document_language] || "?"],
    ["Revision date", record.revision_date || "—", candidate.revision_date || "—"],
    ["Status", record.status || "—", candidate.status || "—"]
  ];
  for (const [label,left,right] of rows) table.append(node("tr",{},[ node("td",{textContent:label}), node("td",{textContent:left}), node("td",{textContent:right}) ]));
  return table;
}

async function groupAsVariant(candidateId) {
  if (!isAdmin() || !state.selectedId || !candidateId) return;
  await api(`/v1/admin/documents/${state.selectedId}/group`, { method:"POST", body:{ link_to_document_id:candidateId, comment:elements.reviewComment.value } });
  showToast("Linked as a language variant under one product record.");
  await openReview(state.selectedId);
}

async function keepSeparate() {
  if (!isAdmin() || !state.selectedId) return;
  await api(`/v1/admin/documents/${state.selectedId}/ungroup`, { method:"POST", body:{ comment:elements.reviewComment.value } });
  showToast("Kept as a separate SDS.");
  await openReview(state.selectedId);
}

function buildValiditySummary(record) {
  const found = Array.isArray(record.sections_found) ? record.sections_found : [];
  const missing = Array.isArray(record.missing_sections) ? record.missing_sections : [];
  const missingText = missing.length ? missing.map((section) => `${section} (${SECTION_TITLES[section] || "?"})`).join(", ") : "None — all 16 present";
  const card = node("div", { className:"field-wide review-summary" });
  card.append(node("span", { className:"review-summary-title", textContent:"SDS dates, validity & 16-section completeness" }));
  const grid = node("div", { className:"review-summary-grid" });
  grid.append(
    summaryRow("Review category", REVIEW_DECISION_LABELS[record.review_decision] || "Legacy full review"),
    summaryRow("Risk level", formatCodeLabel(record.risk_level || "unknown"), record.risk_level === "high"),
    summaryRow("AI verification", formatCodeLabel(record.ai_verification_status || "Not recorded"), ["error","quota_exceeded","timeout","not_configured"].includes(record.ai_verification_status)),
    summaryRow("Existing approved match", record.existing_catalog_match ? "Yes — unchanged hash" : "No"),
    summaryRow("Revision date", record.revision_date || "Not detected"), summaryRow("Issue date", record.issue_date || "Not detected"),
    summaryRow("Preparation date", record.preparation_date || "Not detected"), summaryRow("Establishment date", record.establishment_date || "Not detected"),
    summaryRow("Effective date", record.effective_date || "Not detected"), summaryRow("Print date", record.print_date || "Not detected", record.validity_date_basis === "print_date"),
    summaryRow("Supersedes (previous SDS)", record.supersedes_date || "Not stated"),
    summaryRow("Validity basis", DATE_BASIS_LABELS[record.validity_date_basis] || "Not established", !record.validity_date_basis || record.validity_date_basis === "print_date"),
    summaryRow("Validity date", record.validity_date_value || record.established_date || "Not established", !record.validity_date_value),
    summaryRow("Date confidence", `${record.detected_date_confidence || 0}%`, (record.detected_date_confidence || 0) < 70),
    summaryRow("Detected source", record.detected_date_source || "Not detected"),
    summaryRow("Sections found", `${found.length} of 16 · ${record.section_detection_confidence || 0}%`, found.length < 16),
    summaryRow("Missing sections", missingText, missing.length > 0)
  );
  card.append(grid); return card;
}

function buildEvidenceSummary(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const entries = Object.entries(evidence).filter(([,value]) => String(value || "").trim());
  if (!entries.length) return null;
  const card = node("div", { className:"field-wide evidence-summary" });
  card.append(node("span", { className:"review-summary-title", textContent:"Rule evidence (short excerpts only)" }));
  entries.forEach(([label,value]) => card.append(node("div", { className:"evidence-row" }, [
    node("strong", { textContent:formatCodeLabel(label) }),
    node("span", { textContent:String(value) })
  ])));
  return card;
}

function formatCodeLabel(value) {
  const text = String(value || "").replaceAll("_", " ").trim();
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unknown";
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
  if (!isAdmin()) return;
  await runApprove({ metadata:collectReviewMetadata(), comment:elements.reviewComment.value });
}

async function runApprove(payload) {
  elements.approveButton.disabled = true;
  try {
    const data = await api(`/v1/admin/documents/${state.selectedId}/approve`, { method:"POST", body:payload });
    await finishApproval(data);
  } catch (error) {
    if (error.status === 409 && error.data?.requires_print_date_confirmation) {
      if (confirm("Only the print date is available. Use it as a low-confidence validity basis and approve?")) return runApprove({ ...payload, confirmPrintDate:true });
      return;
    }
    if (error.status === 409 && error.data?.code === "DUPLICATE_APPROVED") return openDuplicateDialog(error.data, payload);
    throw error;
  } finally {
    elements.approveButton.disabled = false;
  }
}

function openDuplicateDialog(data, payload) {
  state.pendingApprovePayload = payload || null;
  state.duplicateExistingId = data?.existing?.id || "";
  elements.duplicateMessage.textContent = data?.error || "This SDS appears to already exist. You can use the existing approved SDS, mark this as duplicate, or upload it as a new revision.";
  const existing = data?.existing || {};
  elements.duplicateExisting.replaceChildren(...[
    ["Existing SDS", existing.product_name || "—"], ["Revision date", existing.revision_date || "—"], ["Approved file", existing.approved_filename || "—"]
  ].map(([label,value]) => node("div", { className:"duplicate-existing-row" }, [
    node("span", { className:"duplicate-existing-label", textContent:label }), node("span", { textContent:String(value) })
  ])));
  if (existing.pdf_url) elements.duplicateExisting.append(node("a", { className:"secondary-action", href:existing.pdf_url, target:"_blank", rel:"noopener", textContent:"Open existing approved SDS" }));
  elements.duplicateMarkButton.disabled = !state.duplicateExistingId;
  elements.duplicateDialog.showModal();
}

async function confirmDuplicateAsDuplicate() {
  const id = state.duplicateExistingId;
  elements.duplicateDialog.close();
  if (!id) return showToast("No existing approved SDS to link to.");
  await markDuplicate(id);
}

async function confirmUploadAsNewRevision() {
  const payload = { ...(state.pendingApprovePayload || { metadata:collectReviewMetadata(), comment:elements.reviewComment.value }), confirmNewRevision:true };
  elements.duplicateDialog.close();
  await runApprove(payload);
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

async function markDuplicate(duplicateOfId) {
  if (!isAdmin()) return;
  const id = (typeof duplicateOfId === "string" && duplicateOfId.trim()) || (prompt("Enter the controlling approved SDS document ID:") || "").trim();
  if (!id) return;
  await documentAction("duplicate", "POST", { duplicate_of_id:id, comment:elements.reviewComment.value });
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
    actionCell.append(button);
    if (!record.deleted_at) {
      const openBtn = node("button", { type:"button", textContent:"Open PDF" });
      openBtn.addEventListener("click", () => openFile("original", record.id));
      actionCell.append(openBtn);
    }
    row.append(actionCell); body.append(row);
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
  const impact = action === "restore" ? "Records will return to the controlled register."
    : action === "purge" ? "This permanently deletes the records and their stored original/approved PDFs. It cannot be undone and there is no backup."
    : "Affected approved SDS records will no longer appear in the public catalog or search/QR results.";
  const verb = action === "delete" ? "soft-deleted" : action === "purge" ? "permanently deleted" : `${action}d`;
  elements.bulkDialogTitle.textContent = action === "purge" ? "Confirm permanent deletion" : `Confirm bulk ${action}`;
  elements.bulkDialogMessage.textContent = `${state.selectedIds.size} SDS record(s) will be ${verb}. ${impact} The action and your identity will be recorded in the audit trail. Type ${word} below.`;
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
  const openPdf = node("button", { className:"secondary-action", type:"button", textContent:"Open original PDF" });
  openPdf.addEventListener("click", () => openFile("original", record.id));
  summary.append(openPdf);
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

const UPLOAD_LIMITS = { pdf: 15 * 1024 * 1024, zip: 20 * 1024 * 1024 };
const UPLOAD_STATUS_LABELS = { processed: "Uploaded · needs review", duplicate: "Possible duplicate", rejected: "Skipped", failed: "Failed" };

function classifyUpload(file) {
  const name = String(file.name || "").trim();
  const isZip = /\.zip$/i.test(name) || ["application/zip", "application/x-zip-compressed"].includes(file.type);
  const isPdf = !isZip && (/\.pdf$/i.test(name) || file.type === "application/pdf");
  return { name, isPdf, isZip };
}

// Client-side gate so users get instant, specific feedback instead of a slow round-trip and a generic error.
function validateUpload(file) {
  const { name, isPdf, isZip } = classifyUpload(file);
  if (!name) return "Skipped: the file has no readable name.";
  if (!isPdf && !isZip) return "Skipped: only PDF or ZIP files are accepted.";
  if (file.size === 0) return "Skipped: the file is empty (0 bytes).";
  const mb = (file.size / 1048576).toFixed(1);
  if (isPdf && file.size > UPLOAD_LIMITS.pdf) return `Skipped: PDF is ${mb} MB; the limit is 15 MB.`;
  if (isZip && file.size > UPLOAD_LIMITS.zip) return `Skipped: ZIP is ${mb} MB; the Edge limit is 20 MB. Split the batch.`;
  return null;
}

function docToResultRow(doc) {
  return {
    filename: doc.original_filename, status: doc.possible_duplicate_flag ? "duplicate" : "processed",
    product_name: doc.product_name || doc.trade_name || null, manufacturer: doc.manufacturer || doc.supplier || null,
    date_detected: doc.validity_date_value || null, date_basis_used: doc.validity_date_basis || null,
    sections_complete: Array.isArray(doc.missing_sections) && doc.missing_sections.length === 0,
    missing_sections: doc.missing_sections || [], reason: doc.ocr_required ? "Scanned/image-only PDF; OCR review required" : null
  };
}

async function uploadDocument(event) {
  event.preventDefault();
  if (state.uploading) return;
  const files = [...(elements.pdfInput.files || [])];
  if (!files.length) return showToast("Select one or more PDF files, or a ZIP batch, first.");

  // Validate and de-duplicate the selection before any network call; invalid files are reported, not silently dropped.
  const rows = []; const queue = []; const seen = new Set();
  for (const file of files) {
    const invalid = validateUpload(file);
    if (invalid) { rows.push({ filename: file.name || "unnamed", status: "rejected", reason: invalid }); continue; }
    const key = `${file.name}::${file.size}`;
    if (seen.has(key)) { rows.push({ filename: file.name, status: "rejected", reason: "Skipped: selected more than once in this batch." }); continue; }
    seen.add(key); queue.push(file);
  }
  if (!queue.length) { renderUploadResults(rows); return showToast("No valid PDF or ZIP files to upload."); }

  state.uploading = true;
  elements.uploadButton.disabled = true; elements.pdfInput.disabled = true;
  elements.uploadProgress.hidden = false; elements.uploadProgress.classList.add("is-busy"); elements.uploadResult.hidden = true; elements.uploadResult.replaceChildren();
  markUploadStep("extract");

  let lastDocId = "";
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index]; const { isZip } = classifyUpload(file);
    elements.uploadButton.textContent = `Processing ${index + 1} of ${queue.length}…`;
    elements.uploadProgress.textContent = `Processing ${index + 1} of ${queue.length}: ${file.name} — ${isZip ? "expanding ZIP and extracting PDFs" : "uploading and extracting metadata"}…`;
    try {
      const form = new FormData(); form.append("file", file, file.name);
      const result = await api("/v1/admin/documents", { method:"POST", body:form });
      if (result.batch) { for (const item of (result.results || [])) rows.push(item); }
      else if (result.document) { rows.push(docToResultRow(result.document)); lastDocId = result.document.id; }
    } catch (error) {
      rows.push({ filename: file.name, status: "failed", reason: error?.data?.detail || error?.message || "Upload failed." });
    }
  }

  renderUploadResults(rows);
  markUploadStep("done");
  elements.uploadProgress.classList.remove("is-busy");
  elements.uploadProgress.textContent = "Completed. Every accepted SDS is in Needs Review and awaits EHS approval.";
  if (lastDocId) { state.selectedId = lastDocId; elements.detailNav.disabled = false; }
  elements.uploadForm.reset();
  state.uploading = false; elements.uploadButton.disabled = false; elements.pdfInput.disabled = false;
  elements.uploadButton.textContent = "Upload and extract";
}

function markUploadStep(active) {
  const order = ["select","extract","review","done"];
  const index = order.indexOf(active);
  elements.uploadStepper?.querySelectorAll(".step").forEach((step) => {
    const position = order.indexOf(step.dataset.step);
    step.classList.toggle("is-active", position === index);
    step.classList.toggle("is-done", position < index);
  });
}

function renderUploadResults(rows) {
  elements.uploadResult.hidden = false; elements.uploadResult.replaceChildren();
  const tally = { processed:0, duplicate:0, rejected:0, failed:0 };
  for (const item of rows) tally[item.status] = (tally[item.status] || 0) + 1;
  elements.uploadResult.append(node("strong", { textContent:
    `${rows.length} file(s): ${tally.processed} uploaded, ${tally.duplicate} possible duplicate, ${tally.rejected} skipped, ${tally.failed} failed. Every accepted SDS requires EHS review before publication.` }));
  const table = node("table", { className:"data-table upload-results-table" });
  const head = node("thead"); head.append(node("tr", {}, ["File","Status","Product","Manufacturer","Date / basis","Sections","Notes"].map((title) => node("th", { textContent:title }))));
  const body = node("tbody");
  for (const item of rows) {
    const sections = item.sections_complete === true ? "16/16"
      : Array.isArray(item.missing_sections) && item.missing_sections.length ? `Missing ${item.missing_sections.join(", ")}` : "-";
    body.append(node("tr", { className:`upload-row upload-row-${item.status}` }, [
      item.filename, UPLOAD_STATUS_LABELS[item.status] || item.status, item.product_name || "-", item.manufacturer || "-",
      item.date_detected ? `${item.date_detected} / ${item.date_basis_used || "unknown"}` : "-", sections, item.reason || "-"
    ].map((value) => node("td", { textContent:String(value) }))));
  }
  table.append(head, body); elements.uploadResult.append(table);
}

async function openFile(variant, documentId) {
  const id = documentId || state.selectedId;
  if (!id) return;
  // Open the tab synchronously inside the click gesture; populating it after the fetch avoids the popup blocker.
  // The blob URL renders inline in the browser's PDF viewer (no forced download).
  const viewer = window.open("", "_blank", "noopener");
  try {
    const token = await accessToken();
    const response = await fetch(`${state.apiUrl}/v1/admin/documents/${id}/file?variant=${encodeURIComponent(variant)}`, { headers:{ Authorization:`Bearer ${token}` } });
    if (!response.ok) throw new Error("PDF could not be opened.");
    const url = URL.createObjectURL(await response.blob());
    if (viewer) viewer.location = url; else window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (error) { if (viewer) viewer.close(); showToast(error.message); }
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
