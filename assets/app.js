import {
  availableLanguages,
  buildProductGroups,
  EMPLOYEE_LANGUAGES,
  filterCatalog,
  formatRevisionDate,
  getDepartments,
  getLanguages,
  languageLabel,
  pickVariant,
  resolveDepartment,
  resolveLanguage,
  sanitizeCatalog,
  validityStatus
} from "./catalog-utils.js";

const VALIDITY_LABELS = {
  valid: "Valid",
  expiring: "Expiring soon",
  expired: "Expired",
  unknown: "Verify validity"
};

const DATA_URL = "./data/sds-data.json";
const DOCUMENT_CACHE = "sds-documents-v1";
const PDF_SIGNATURE = "%PDF-";

const config = Object.freeze({
  siteName: "Digital SDS Hub",
  facilityName: "Safety library",
  emergencyLabel: "",
  emergencyHref: "",
  aiEnabled: false,
  aiProxyUrl: "",
  catalogApiUrl: "",
  maxQuestionLength: 500,
  ...(window.SDS_CONFIG || {})
});

const elements = {
  siteName: document.querySelector("#siteName"),
  facilityName: document.querySelector("#facilityName"),
  emergencyLink: document.querySelector("#emergencyLink"),
  searchInput: document.querySelector("#searchInput"),
  clearSearch: document.querySelector("#clearSearch"),
  resetFilters: document.querySelector("#resetFilters"),
  departmentFilters: document.querySelector("#departmentFilters"),
  languageFilters: document.querySelector("#languageFilters"),
  expiryReminder: document.querySelector("#expiryReminder"),
  resultsCount: document.querySelector("#resultsCount"),
  resultsList: document.querySelector("#resultsList"),
  loadingState: document.querySelector("#loadingState"),
  errorState: document.querySelector("#errorState"),
  emptyCatalogState: document.querySelector("#emptyCatalogState"),
  noResultsState: document.querySelector("#noResultsState"),
  retryLoad: document.querySelector("#retryLoad"),
  detailPlaceholder: document.querySelector("#detailPlaceholder"),
  detailPanel: document.querySelector("#detailPanel"),
  detailDepartment: document.querySelector("#detailDepartment"),
  detailRevision: document.querySelector("#detailRevision"),
  detailValidity: document.querySelector("#detailValidity"),
  detailTitle: document.querySelector("#detailTitle"),
  detailManufacturer: document.querySelector("#detailManufacturer"),
  detailProductCode: document.querySelector("#detailProductCode"),
  detailLocation: document.querySelector("#detailLocation"),
  manufacturerRow: document.querySelector("#manufacturerRow"),
  productCodeRow: document.querySelector("#productCodeRow"),
  locationRow: document.querySelector("#locationRow"),
  hazardTags: document.querySelector("#hazardTags"),
  pdfLink: document.querySelector("#pdfLink"),
  previewButton: document.querySelector("#previewButton"),
  pdfPreviewPanel: document.querySelector("#pdfPreviewPanel"),
  pdfViewer: document.querySelector("#pdfViewer"),
  offlineButton: document.querySelector("#offlineButton"),
  offlineStatus: document.querySelector("#offlineStatus"),
  aiPanel: document.querySelector("#aiPanel"),
  aiQuestion: document.querySelector("#aiQuestion"),
  questionCounter: document.querySelector("#questionCounter"),
  askAiButton: document.querySelector("#askAiButton"),
  aiResponse: document.querySelector("#aiResponse"),
  catalogUpdated: document.querySelector("#catalogUpdated"),
  detailLanguageSwitcher: document.querySelector("#detailLanguageSwitcher"),
  toast: document.querySelector("#toast")
};

function readPreferredLanguage() {
  try { const stored = localStorage.getItem("sdsEmployeeLang"); if (stored === "en" || stored === "ms") return stored; } catch { /* storage blocked */ }
  return "en"; // default to English
}

const state = {
  catalog: [],
  departments: [],
  languages: [],
  query: "",
  department: "All",
  language: "All",
  expiringOnly: false,
  selectedId: "",
  preferredLanguage: readPreferredLanguage(),
  updatedAt: "",
  loaded: false,
  previewToken: 0
};

let toastTimer;

function applyConfiguration() {
  elements.siteName.textContent = config.siteName;
  elements.facilityName.textContent = config.facilityName;
  document.title = config.siteName;

  const emergencyHref = safeHttpUrl(config.emergencyHref, { allowRelative: true });
  if (config.emergencyLabel && emergencyHref) {
    elements.emergencyLink.textContent = config.emergencyLabel;
    elements.emergencyLink.href = emergencyHref;
    elements.emergencyLink.hidden = false;
  }

  const maxLength = Number.isInteger(config.maxQuestionLength)
    ? Math.min(Math.max(config.maxQuestionLength, 50), 1000)
    : 500;
  elements.aiQuestion.maxLength = maxLength;
  elements.questionCounter.textContent = `0 / ${maxLength}`;

  const proxyUrl = safeHttpUrl(config.aiProxyUrl);
  elements.aiPanel.hidden = !(config.aiEnabled && proxyUrl);
}

function safeHttpUrl(value, { allowRelative = false } = {}) {
  if (!value || typeof value !== "string") return "";

  try {
    const url = new URL(value, window.location.href);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const isSameOriginRelative = allowRelative && url.origin === window.location.origin;
    if (url.protocol !== "https:" && !isLocalDevelopment(url) && !isSameOriginRelative) return "";
    return url.href;
  } catch {
    return "";
  }
}

function isLocalDevelopment(url) {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function loadCatalog() {
  setLoadState("loading");

  try {
    const basePayload = await fetchCatalog(DATA_URL);
    const baseCatalog = sanitizeCatalog(basePayload.documents);
    if (baseCatalog.length !== basePayload.documents.length) throw new Error("One or more local catalog records failed validation");

    let supplementalPayload = null;
    const supplementalUrl = safeHttpUrl(config.catalogApiUrl);
    if (supplementalUrl) {
      try { supplementalPayload = await fetchCatalog(supplementalUrl); }
      catch (error) { console.warn("Approved intake catalog is temporarily unavailable; using the GitHub Pages catalog.", error); }
    }
    const supplementalCatalog = supplementalPayload ? sanitizeCatalog(supplementalPayload.documents) : [];
    if (supplementalPayload && supplementalCatalog.length !== supplementalPayload.documents.length) {
      console.warn("Some supplemental catalog records failed validation and were not published.");
    }
    const merged = new Map(baseCatalog.map((documentRecord) => [documentRecord.id, documentRecord]));
    for (const documentRecord of supplementalCatalog) merged.set(documentRecord.id, documentRecord);
    const catalog = sanitizeCatalog([...merged.values()]);

    state.catalog = catalog;
    state.departments = getDepartments(catalog);
    state.languages = getLanguages(catalog);
    state.updatedAt = [basePayload.updatedAt, supplementalPayload?.updatedAt].filter(Boolean).sort().at(-1) || "";
    state.loaded = true;

    applyRoute();
    renderDepartmentFilters();
    renderLanguageFilters();
    renderExpiryReminder();
    renderCatalog();
    updateCatalogTimestamp();
    await pruneOfflineDocuments();
    setLoadState(catalog.length === 0 ? "empty" : "ready");
  } catch (error) {
    console.error("Unable to load the SDS catalog", error);
    state.loaded = false;
    state.catalog = [];
    state.departments = [];
    state.selectedId = "";
    setLoadState("error");
    showDetailPlaceholder();
  }
}

async function fetchCatalog(url) {
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.documents)) throw new Error("Catalog schema is invalid");
  return payload;
}

function setLoadState(mode) {
  elements.loadingState.hidden = mode !== "loading";
  elements.errorState.hidden = mode !== "error";
  elements.emptyCatalogState.hidden = mode !== "empty";
  elements.resultsList.hidden = mode === "loading" || mode === "error" || mode === "empty";

  if (mode === "loading") elements.resultsCount.textContent = "Loading...";
  if (mode === "error") elements.resultsCount.textContent = "Unavailable";
  if (mode === "empty") elements.resultsCount.textContent = "0 documents";
}

function applyRoute() {
  const params = new URLSearchParams(window.location.search);
  state.department = resolveDepartment(params.get("dept"), state.departments);
  state.language = resolveLanguage(params.get("lang"), state.languages);

  const requestedId = params.get("chemical") || "";
  const requestedDocument = state.catalog.find((document) => document.id === requestedId);
  state.selectedId = requestedDocument?.id || "";

  if (requestedDocument) showDocument(requestedDocument, { updateHistory: false, scroll: false });
  else if (state.catalog.length === 1) showDocument(state.catalog[0], { updateHistory: false, scroll: false });
  else showDetailPlaceholder();
}

function renderDepartmentFilters() {
  const fragment = document.createDocumentFragment();
  const departments = ["All", ...state.departments];

  departments.forEach((department) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-button";
    button.dataset.department = department;
    button.setAttribute("aria-pressed", String(department === state.department));
    button.textContent = department === "All" ? "All departments" : department;
    fragment.append(button);
  });

  elements.departmentFilters.replaceChildren(fragment);
  updateResetButton();
}

function renderLanguageFilters() {
  if (!elements.languageFilters) return;
  const fragment = document.createDocumentFragment();
  const languages = ["All", ...state.languages];

  languages.forEach((language) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-button";
    button.dataset.language = language;
    button.setAttribute("aria-pressed", String(language === state.language));
    button.textContent = language === "All" ? "All languages" : languageLabel(language);
    fragment.append(button);
  });

  elements.languageFilters.replaceChildren(fragment);
}

function selectLanguage(language) {
  if (language !== "All" && !state.languages.includes(language)) return;
  state.language = language;

  for (const button of elements.languageFilters.querySelectorAll(".filter-button")) {
    button.setAttribute("aria-pressed", String(button.dataset.language === language));
  }

  updateResetButton();
  updateUrl({ replace: true });
  renderCatalog();
}

function renderExpiryReminder() {
  const element = elements.expiryReminder;
  if (!element) return;
  const count = state.catalog.filter((documentRecord) => validityStatus(documentRecord).state === "expiring").length;
  if (count === 0) {
    state.expiringOnly = false;
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.setAttribute("aria-pressed", String(state.expiringOnly));
  element.classList.toggle("is-active", state.expiringOnly);
  element.textContent = state.expiringOnly
    ? `Showing ${count} SDS expiring within 2 months - tap to show all documents`
    : `${count} SDS expiring within 2 months - tap to view the list`;
}

function renderCatalog() {
  if (!state.loaded) return;

  let matches = filterCatalog(state.catalog, state.query, state.department, state.language);
  if (state.expiringOnly) matches = matches.filter((document) => validityStatus(document).state === "expiring");
  // Collapse EHS-grouped language variants into one product entry (a no-op until variants are linked,
  // since each ungrouped document is its own single-variant product).
  const groups = buildProductGroups(matches);
  elements.resultsList.replaceChildren();
  elements.noResultsState.hidden = groups.length > 0 || state.catalog.length === 0;
  elements.resultsList.hidden = groups.length === 0 || state.catalog.length === 0;
  elements.resultsCount.textContent = `${groups.length} ${groups.length === 1 ? "document" : "documents"}`;

  if (groups.length === 0) return;

  const fragment = document.createDocumentFragment();
  groups.forEach((group) => {
    const representative = pickVariant(group.variants, state.preferredLanguage) || group.representative;
    fragment.append(createResultItem(representative, group));
  });
  elements.resultsList.append(fragment);
}

function createResultItem(documentRecord, group = null) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  const icon = document.createElement("span");
  const content = document.createElement("span");
  const title = document.createElement("span");
  const meta = document.createElement("span");
  const department = document.createElement("span");

  button.type = "button";
  button.className = "result-button";
  button.dataset.documentId = documentRecord.id;
  button.setAttribute("aria-current", String(documentRecord.id === state.selectedId));

  icon.className = "result-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "PDF";

  content.className = "result-content";
  title.className = "result-title";
  title.textContent = documentRecord.name;
  meta.className = "result-meta";

  const manufacturer = document.createElement("span");
  manufacturer.textContent = documentRecord.manufacturer || "Approved SDS";
  const revision = document.createElement("span");
  revision.textContent = documentRecord.revisionDate
    ? `Rev. ${formatRevisionDate(documentRecord.revisionDate)}`
    : "Revision date not stated";
  const documentType = document.createElement("span");
  documentType.textContent = documentRecord.documentType;
  meta.append(manufacturer, documentType, revision);

  if (group && group.languages.length > 1) {
    const language = document.createElement("span");
    language.className = "result-language";
    language.textContent = "English / Bahasa Melayu";
    meta.append(language);
  } else if (documentRecord.language) {
    const language = document.createElement("span");
    language.className = "result-language";
    language.textContent = languageLabel(documentRecord.language);
    meta.append(language);
  }

  const validity = validityStatus(documentRecord);
  if (validity.state !== "valid") {
    const badge = document.createElement("span");
    badge.className = `result-validity result-validity--${validity.state}`;
    badge.textContent = validity.state === "expired"
      ? "Expired"
      : validity.state === "expiring" ? "Expiring soon" : "Verify validity";
    meta.append(badge);
  }

  department.className = "result-department";
  department.textContent = documentRecord.department;

  content.append(title, meta);
  button.append(icon, content, department);
  item.append(button);
  return item;
}

function selectDepartment(department) {
  if (department !== "All" && !state.departments.includes(department)) return;
  state.department = department;

  for (const button of elements.departmentFilters.querySelectorAll(".filter-button")) {
    button.setAttribute("aria-pressed", String(button.dataset.department === department));
  }

  updateResetButton();
  updateUrl({ replace: true });
  renderCatalog();
}

function updateResetButton() {
  elements.resetFilters.hidden = state.department === "All" && state.language === "All" && !state.query && !state.expiringOnly;
}

function selectDocumentById(documentId, options) {
  const documentRecord = state.catalog.find((item) => item.id === documentId);
  if (!documentRecord) return;
  showDocument(documentRecord, options);
}

// Language variants of one product grouped by EHS, plus the currently displayed document.
function variantsForDocument(documentRecord) {
  return documentRecord.groupId
    ? state.catalog.filter((item) => item.groupId && item.groupId === documentRecord.groupId)
    : [documentRecord];
}

// Employee language chooser shown on the detail view when a product has more than one language.
// Default English; remembers the choice; a bilingual PDF satisfies both languages.
function renderLanguageSwitcher(documentRecord) {
  const container = elements.detailLanguageSwitcher;
  if (!container) return;
  container.replaceChildren();
  const variants = variantsForDocument(documentRecord);
  const languages = availableLanguages(variants);
  if (variants.length <= 1 && languages.length <= 1) { container.hidden = true; return; }
  container.hidden = false;

  const activeCode = documentRecord.documentLanguage === "bilingual" || documentRecord.isBilingual
    ? state.preferredLanguage
    : documentRecord.documentLanguage;
  for (const { code, label } of EMPLOYEE_LANGUAGES) {
    if (!languages.includes(code)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lang-switch-button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(code === activeCode));
    button.addEventListener("click", () => selectEmployeeLanguage(code, documentRecord.groupId));
    container.append(button);
  }

  const note = document.createElement("span");
  note.className = "lang-switch-note";
  if (languages.length === 1) {
    note.textContent = languages[0] === "en"
      ? "Only the English SDS is currently available."
      : "Only the Bahasa Melayu SDS is currently available.";
  } else if (variants.some((variant) => variant.documentLanguage === "bilingual" || variant.isBilingual)) {
    note.textContent = "Bilingual English / Bahasa Melayu SDS available.";
  } else {
    note.textContent = "Choose your language.";
  }
  container.append(note);
}

function selectEmployeeLanguage(language, groupId) {
  if (language !== "en" && language !== "ms") return;
  state.preferredLanguage = language;
  try { localStorage.setItem("sdsEmployeeLang", language); } catch { /* storage blocked */ }
  // If this product has separate language variants, switch to the one for the chosen language.
  if (groupId) {
    const variant = pickVariant(state.catalog.filter((item) => item.groupId === groupId), language);
    if (variant && variant.id !== state.selectedId) { showDocument(variant); return; }
  }
  // Otherwise (a single bilingual PDF, or the variant is already shown) keep the document but refresh
  // the switcher so the selected language highlights — the bilingual PDF serves both languages.
  const current = state.catalog.find((item) => item.id === state.selectedId);
  if (current) renderLanguageSwitcher(current);
}

function showDocument(documentRecord, { updateHistory = true, scroll = true } = {}) {
  state.selectedId = documentRecord.id;
  elements.detailPlaceholder.hidden = true;
  elements.detailPanel.hidden = false;
  elements.detailDepartment.textContent = documentRecord.department;
  const revisionLabel = documentRecord.revisionDate
    ? `Revision ${formatRevisionDate(documentRecord.revisionDate)}`
    : "Revision date not stated";
  elements.detailRevision.textContent = `${documentRecord.documentType} - ${revisionLabel}`;
  elements.detailTitle.textContent = documentRecord.name;
  setValidity(documentRecord);
  renderLanguageSwitcher(documentRecord);

  setMetadata(elements.manufacturerRow, elements.detailManufacturer, documentRecord.manufacturer);
  setMetadata(elements.productCodeRow, elements.detailProductCode, documentRecord.productCode);
  setMetadata(elements.locationRow, elements.detailLocation, documentRecord.location);

  const tagFragment = document.createDocumentFragment();
  for (const hazard of documentRecord.hazards) {
    const tag = document.createElement("span");
    tag.className = "hazard-tag";
    tag.textContent = hazard;
    tagFragment.append(tag);
  }
  elements.hazardTags.replaceChildren(tagFragment);
  elements.hazardTags.hidden = documentRecord.hazards.length === 0;

  const pdfUrl = getDocumentPdfUrl(documentRecord);       // direct GitHub link (downloads on some hosts)
  const previewUrl = getPreviewPdfUrl(documentRecord);    // same-origin proxy — served inline, for preview + "Open PDF"
  // "Open official SDS PDF" points at the inline proxy so it opens in a new tab instead of downloading.
  elements.pdfLink.href = previewUrl;
  elements.pdfLink.dataset.pdfUrl = previewUrl;
  elements.previewButton.dataset.pdfUrl = previewUrl;
  elements.previewButton.setAttribute("aria-expanded", "false");
  elements.previewButton.querySelector("span").textContent = "Preview PDF on this page";
  elements.pdfPreviewPanel.hidden = true;
  state.previewToken += 1;
  elements.pdfViewer.replaceChildren();
  elements.offlineButton.dataset.pdfUrl = previewUrl;
  elements.offlineButton.dataset.revisionDate = documentRecord.revisionDate;
  elements.offlineButton.disabled = false;
  elements.offlineButton.querySelector("span").textContent = "Store offline on this device";
  resetOfflineStatus();
  void updateOfflineStatus(previewUrl, documentRecord.revisionDate);

  elements.aiQuestion.value = "";
  updateQuestionCounter();
  elements.aiResponse.hidden = true;
  elements.aiResponse.textContent = "";
  elements.aiResponse.classList.remove("is-error");
  const configuredProxy = safeHttpUrl(config.aiProxyUrl);
  elements.aiPanel.hidden = !(config.aiEnabled && configuredProxy && documentRecord.documentType === "SDS");

  for (const button of elements.resultsList.querySelectorAll(".result-button")) {
    button.setAttribute("aria-current", String(button.dataset.documentId === documentRecord.id));
  }

  if (updateHistory) updateUrl({ replace: false });
  if (scroll && window.matchMedia("(max-width: 900px)").matches) {
    elements.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function showDetailPlaceholder() {
  state.selectedId = "";
  elements.detailPlaceholder.hidden = false;
  elements.detailPanel.hidden = true;
}

function setMetadata(row, valueElement, value) {
  row.hidden = !value;
  valueElement.textContent = value || "";
}

function setValidity(documentRecord) {
  const element = elements.detailValidity;
  if (!element) return;
  const status = validityStatus(documentRecord);
  element.className = `validity-line validity-${status.state}`;
  if (status.state === "unknown") {
    element.textContent = "Validity unknown - verify the revision date on the official SDS.";
  } else if (status.state === "expired") {
    element.textContent = `Expired ${formatRevisionDate(status.expiryDate)} - confirm a current SDS with the safety manager.`;
  } else if (status.state === "expiring") {
    element.textContent = `Valid until ${formatRevisionDate(status.expiryDate)} (expiring soon).`;
  } else {
    element.textContent = `Valid until ${formatRevisionDate(status.expiryDate)}.`;
  }
}

function updateUrl({ replace }) {
  const url = new URL(window.location.href);

  if (state.department === "All") url.searchParams.delete("dept");
  else url.searchParams.set("dept", state.department);

  if (state.language === "All") url.searchParams.delete("lang");
  else url.searchParams.set("lang", state.language);

  if (state.selectedId) url.searchParams.set("chemical", state.selectedId);
  else url.searchParams.delete("chemical");

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", url);
}

function updateCatalogTimestamp() {
  if (!state.updatedAt || Number.isNaN(Date.parse(`${state.updatedAt}T00:00:00Z`))) {
    elements.catalogUpdated.textContent = "Catalog date unavailable";
    return;
  }
  elements.catalogUpdated.textContent = `Catalog updated ${formatRevisionDate(state.updatedAt)}`;
}

async function updateOfflineStatus(pdfUrl, revisionDate) {
  if (!("caches" in window)) {
    elements.offlineButton.hidden = true;
    elements.offlineStatus.textContent = "Offline storage is not supported by this browser. Use the site-approved backup SDS source.";
    return;
  }

  try {
    const cache = await caches.open(DOCUMENT_CACHE);
    const cached = await cache.match(pdfUrl);
    if (!cached || elements.offlineButton.dataset.pdfUrl !== pdfUrl) return;

    elements.offlineButton.querySelector("span").textContent = "Refresh offline copy";
    const revisionLabel = revisionDate ? `SDS revision ${formatRevisionDate(revisionDate)}` : "revision date not stated";
    elements.offlineStatus.textContent = `Stored on this device for offline use (${revisionLabel}). Device storage may still be cleared.`;
    elements.offlineStatus.classList.add("is-ready");
  } catch (error) {
    console.warn("Unable to read offline cache status", error);
  }
}

function resetOfflineStatus() {
  elements.offlineButton.hidden = false;
  elements.offlineStatus.textContent = "Offline copies are device-specific and may be cleared. Keep the site-approved backup available.";
  elements.offlineStatus.classList.remove("is-ready");
}

function togglePdfPreview() {
  const pdfUrl = elements.previewButton.dataset.pdfUrl;
  if (!pdfUrl) return;

  const willOpen = elements.pdfPreviewPanel.hidden;
  elements.pdfPreviewPanel.hidden = !willOpen;
  elements.previewButton.setAttribute("aria-expanded", String(willOpen));
  elements.previewButton.querySelector("span").textContent = willOpen
    ? "Hide PDF preview"
    : "Preview PDF on this page";

  if (willOpen) {
    void renderPdfPreview(pdfUrl);
    window.setTimeout(() => elements.pdfPreviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
  } else {
    state.previewToken += 1;
    elements.pdfViewer.replaceChildren();
  }
}

async function renderPdfPreview(pdfUrl) {
  const token = (state.previewToken += 1);
  const viewer = elements.pdfViewer;
  showPreviewMessage("Loading preview...");

  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    showPreviewMessage("The PDF preview component is unavailable. Use “Open official SDS PDF”.");
    return;
  }

  let pdf;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./assets/vendor/pdf.worker.min.js", document.baseURI).href;
    pdf = await pdfjsLib.getDocument({ url: pdfUrl, isEvalSupported: false }).promise;
    if (token !== state.previewToken) return;

    const pageCount = Math.min(pdf.numPages, 50);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = Math.max(viewer.clientWidth - 16, 280);
    viewer.replaceChildren();

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      if (token !== state.previewToken) { page.cleanup(); return; }

      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (cssWidth / baseViewport.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      viewer.append(canvas);

      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      page.cleanup();
      if (token !== state.previewToken) return;
    }

    if (pdf.numPages > pageCount) {
      const note = document.createElement("p");
      note.className = "pdf-viewer-status";
      note.textContent = `Showing the first ${pageCount} pages. Use “Open official SDS PDF” for the full document.`;
      viewer.append(note);
    }
  } catch (error) {
    console.error("Unable to render the PDF preview", error);
    if (token === state.previewToken) {
      showPreviewMessage("This preview could not be displayed here. Use “Open official SDS PDF” to read the document.");
    }
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
  }
}

function showPreviewMessage(message) {
  const status = document.createElement("p");
  status.className = "pdf-viewer-status";
  status.textContent = message;
  elements.pdfViewer.replaceChildren(status);
}

async function storeOfflineCopy() {
  const pdfUrl = elements.offlineButton.dataset.pdfUrl;
  const revisionDate = elements.offlineButton.dataset.revisionDate;
  if (!pdfUrl || !("caches" in window)) return;

  elements.offlineButton.disabled = true;
  elements.offlineButton.querySelector("span").textContent = "Verifying and storing...";
  elements.offlineStatus.textContent = "Downloading the approved PDF...";
  elements.offlineStatus.classList.remove("is-ready");

  try {
    const response = await fetch(pdfUrl, { cache: "reload" });
    if (!response.ok) throw new Error(`PDF returned HTTP ${response.status}`);

    const body = await response.arrayBuffer();
    const signature = new TextDecoder("ascii").decode(body.slice(0, 5));
    if (signature !== PDF_SIGNATURE) throw new Error("The downloaded file is not a valid PDF");

    const cache = await caches.open(DOCUMENT_CACHE);
    const cachedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    await cache.put(pdfUrl, cachedResponse);

    elements.offlineButton.querySelector("span").textContent = "Refresh offline copy";
    const revisionLabel = revisionDate ? `SDS revision ${formatRevisionDate(revisionDate)}` : "revision date not stated";
    elements.offlineStatus.textContent = `Stored on this device for offline use (${revisionLabel}). Device storage may still be cleared.`;
    elements.offlineStatus.classList.add("is-ready");
    showToast("Verified SDS PDF stored for offline use.");
  } catch (error) {
    console.error("Unable to store the SDS offline", error);
    elements.offlineButton.querySelector("span").textContent = "Try offline storage again";
    elements.offlineStatus.textContent = "The PDF could not be verified and stored. Use the site-approved backup SDS source.";
    showToast("Offline storage failed. The PDF was not saved.");
  } finally {
    elements.offlineButton.disabled = false;
  }
}

async function pruneOfflineDocuments() {
  if (!("caches" in window)) return;

  try {
    const cache = await caches.open(DOCUMENT_CACHE);
    const allowedUrls = new Set(state.catalog.flatMap((doc) => [getDocumentPdfUrl(doc), getPreviewPdfUrl(doc)]));
    const requests = await cache.keys();
    await Promise.all(requests.filter((request) => !allowedUrls.has(request.url)).map((request) => cache.delete(request)));
  } catch (error) {
    console.warn("Unable to prune old offline documents", error);
  }
}

function getDocumentPdfUrl(documentRecord) {
  return safeHttpUrl(documentRecord.pdfUrl) || new URL(`./pdfs/${documentRecord.file}`, window.location.href).href;
}

// URL for byte-fetching the PDF in-page (PDF.js preview + offline cache). GitHub release assets are
// cross-origin and send no CORS headers, so we route them through the same-origin catalog proxy.
// Same-origin local ./pdfs/ files (and deployments without a catalog API) are fetched directly.
function getPreviewPdfUrl(documentRecord) {
  const catalogApi = safeHttpUrl(config.catalogApiUrl);
  if (catalogApi && documentRecord.pdfUrl && /^https?:\/\//i.test(documentRecord.pdfUrl)) {
    return `${config.catalogApiUrl.replace(/\/$/, "")}/file?id=${encodeURIComponent(documentRecord.id)}`;
  }
  return getDocumentPdfUrl(documentRecord);
}

function updateQuestionCounter() {
  elements.questionCounter.textContent = `${elements.aiQuestion.value.length} / ${elements.aiQuestion.maxLength}`;
}

// Render the AI answer's light markdown (headings, **bold**, and nested bullet lists) into safe DOM
// nodes — built with textContent only (never innerHTML), so AI output cannot inject markup. Indented
// bullets become nested <ul>s so grouped sub-points (e.g. PPE by body part) keep their structure.
function renderAiAnswer(container, text) {
  container.replaceChildren();
  const stack = []; // open lists by indent depth: [{ indent, ul }]
  for (const rawLine of String(text).replace(/\r/g, "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) { stack.length = 0; continue; }
    const indent = (rawLine.match(/^[ \t]*/)[0]).replace(/\t/g, "  ").length;
    const bullet = trimmed.match(/^(?:[*\-•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const li = document.createElement("li");
      appendInlineMarkdown(li, bullet[1]);
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || indent > top.indent) {
        const ul = document.createElement("ul");
        if (top && top.ul.lastElementChild) top.ul.lastElementChild.append(ul); // nest under the parent bullet
        else container.append(ul);
        stack.push({ indent, ul });
        top = stack[stack.length - 1];
      }
      top.ul.append(li);
      continue;
    }
    stack.length = 0;
    const heading = trimmed.match(/^#{1,4}\s+(.*)$/) || trimmed.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (heading) {
      const node = document.createElement("p");
      node.className = "ai-answer-heading";
      const strong = document.createElement("strong");
      strong.textContent = heading[1].replace(/:$/, "");
      node.append(strong);
      container.append(node);
      continue;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, trimmed);
    container.append(paragraph);
  }
}

function appendInlineMarkdown(parent, text) {
  for (const part of String(text).split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) { const strong = document.createElement("strong"); strong.textContent = bold[1]; parent.append(strong); }
    else parent.append(document.createTextNode(part.replace(/\*\*/g, "")));
  }
}

async function askAssistant() {
  const documentRecord = state.catalog.find((item) => item.id === state.selectedId);
  const question = elements.aiQuestion.value.trim();
  const proxyUrl = safeHttpUrl(config.aiProxyUrl);
  if (!documentRecord || !question || !proxyUrl || !config.aiEnabled) return;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 28000); // > backend Gemini timeout (25s)
  elements.askAiButton.disabled = true;
  elements.askAiButton.textContent = "Checking...";
  elements.aiResponse.hidden = false;
  elements.aiResponse.classList.remove("is-error");
  elements.aiResponse.textContent = "Reviewing the supplemental safety guidance...";

  try {
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        chemicalId: documentRecord.id,
        chemicalName: documentRecord.name,
        department: documentRecord.department,
        question
      }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.answer !== "string" || !payload.answer.trim()) {
      throw new Error(payload.error || `Assistant returned HTTP ${response.status}`);
    }

    renderAiAnswer(elements.aiResponse, payload.answer.trim());
  } catch (error) {
    console.error("AI assistance failed", error);
    elements.aiResponse.classList.add("is-error");
    const reason = String(error?.message || "");
    const networkOrTimeout = !reason || /Failed to fetch|NetworkError|aborted|abort/i.test(reason);
    // Show the server's specific reason (e.g. "busy — free-tier limit, wait a minute") instead of a
    // generic outage message, so a temporary rate limit isn't mistaken for a broken feature.
    elements.aiResponse.textContent = networkOrTimeout
      ? "AI assistance is temporarily unavailable. Open the official SDS PDF for authoritative safety information. For an active emergency, follow the site emergency plan."
      : `${reason} For authoritative information, open the official SDS PDF; in an emergency follow the site emergency plan.`;
  } finally {
    window.clearTimeout(timeout);
    elements.askAiButton.disabled = false;
    elements.askAiButton.textContent = "Ask assistant";
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

function bindEvents() {
  elements.searchInput.addEventListener("input", () => {
    state.query = elements.searchInput.value;
    elements.clearSearch.hidden = !state.query;
    updateResetButton();
    renderCatalog();
  });

  elements.clearSearch.addEventListener("click", () => {
    state.query = "";
    elements.searchInput.value = "";
    elements.clearSearch.hidden = true;
    updateResetButton();
    renderCatalog();
    elements.searchInput.focus();
  });

  elements.resetFilters.addEventListener("click", () => {
    state.query = "";
    state.department = "All";
    state.language = "All";
    state.expiringOnly = false;
    elements.searchInput.value = "";
    elements.clearSearch.hidden = true;
    renderDepartmentFilters();
    renderLanguageFilters();
    renderExpiryReminder();
    updateUrl({ replace: true });
    renderCatalog();
  });

  elements.departmentFilters.addEventListener("click", (event) => {
    const button = event.target.closest(".filter-button");
    if (button) selectDepartment(button.dataset.department);
  });

  if (elements.languageFilters) {
    elements.languageFilters.addEventListener("click", (event) => {
      const button = event.target.closest(".filter-button");
      if (button) selectLanguage(button.dataset.language);
    });
  }

  if (elements.expiryReminder) {
    elements.expiryReminder.addEventListener("click", () => {
      state.expiringOnly = !state.expiringOnly;
      updateResetButton();
      renderExpiryReminder();
      renderCatalog();
    });
  }

  elements.resultsList.addEventListener("click", (event) => {
    const button = event.target.closest(".result-button");
    if (button) selectDocumentById(button.dataset.documentId);
  });

  elements.retryLoad.addEventListener("click", () => void loadCatalog());
  elements.previewButton.addEventListener("click", togglePdfPreview);
  elements.offlineButton.addEventListener("click", () => void storeOfflineCopy());
  elements.aiQuestion.addEventListener("input", updateQuestionCounter);
  elements.askAiButton.addEventListener("click", () => void askAssistant());
  elements.aiQuestion.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void askAssistant();
  });

  window.addEventListener("popstate", () => {
    if (!state.loaded) return;
    applyRoute();
    renderDepartmentFilters();
    renderLanguageFilters();
    renderCatalog();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || window.location.protocol === "file:") return;
  try {
    await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
  } catch (error) {
    console.warn("Offline application shell is unavailable", error);
  }
}

applyConfiguration();
bindEvents();
void loadCatalog();
void registerServiceWorker();
