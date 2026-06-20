import {
  filterCatalog,
  formatRevisionDate,
  getDepartments,
  getLanguages,
  languageLabel,
  resolveDepartment,
  resolveLanguage,
  sanitizeCatalog
} from "./catalog-utils.js";

const DATA_URL = "./data/sds-data.json";
const DOCUMENT_CACHE = "sds-documents-v1";
const PDF_SIGNATURE = "%PDF-";

const config = Object.freeze({
  siteName: "Digital SDS Hub",
  facilityName: "Facility safety library",
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
  toast: document.querySelector("#toast")
};

const state = {
  catalog: [],
  departments: [],
  languages: [],
  query: "",
  department: "All",
  language: "All",
  selectedId: "",
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

function renderCatalog() {
  if (!state.loaded) return;

  const matches = filterCatalog(state.catalog, state.query, state.department, state.language);
  elements.resultsList.replaceChildren();
  elements.noResultsState.hidden = matches.length > 0 || state.catalog.length === 0;
  elements.resultsList.hidden = matches.length === 0 || state.catalog.length === 0;
  elements.resultsCount.textContent = `${matches.length} ${matches.length === 1 ? "document" : "documents"}`;

  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  matches.forEach((document) => fragment.append(createResultItem(document)));
  elements.resultsList.append(fragment);
}

function createResultItem(documentRecord) {
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

  if (documentRecord.language) {
    const language = document.createElement("span");
    language.className = "result-language";
    language.textContent = languageLabel(documentRecord.language);
    meta.append(language);
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
  elements.resetFilters.hidden = state.department === "All" && state.language === "All" && !state.query;
}

function selectDocumentById(documentId, options) {
  const documentRecord = state.catalog.find((item) => item.id === documentId);
  if (!documentRecord) return;
  showDocument(documentRecord, options);
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

  const pdfUrl = getDocumentPdfUrl(documentRecord);
  elements.pdfLink.href = pdfUrl;
  elements.pdfLink.dataset.pdfUrl = pdfUrl;
  elements.previewButton.dataset.pdfUrl = pdfUrl;
  elements.previewButton.setAttribute("aria-expanded", "false");
  elements.previewButton.querySelector("span").textContent = "Preview PDF on this page";
  elements.pdfPreviewPanel.hidden = true;
  state.previewToken += 1;
  elements.pdfViewer.replaceChildren();
  elements.offlineButton.dataset.pdfUrl = pdfUrl;
  elements.offlineButton.dataset.revisionDate = documentRecord.revisionDate;
  elements.offlineButton.disabled = false;
  elements.offlineButton.querySelector("span").textContent = "Store offline on this device";
  resetOfflineStatus();
  void updateOfflineStatus(pdfUrl, documentRecord.revisionDate);

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
    const allowedUrls = new Set(state.catalog.map(getDocumentPdfUrl));
    const requests = await cache.keys();
    await Promise.all(requests.filter((request) => !allowedUrls.has(request.url)).map((request) => cache.delete(request)));
  } catch (error) {
    console.warn("Unable to prune old offline documents", error);
  }
}

function getDocumentPdfUrl(documentRecord) {
  return safeHttpUrl(documentRecord.pdfUrl) || new URL(`./pdfs/${documentRecord.file}`, window.location.href).href;
}

function updateQuestionCounter() {
  elements.questionCounter.textContent = `${elements.aiQuestion.value.length} / ${elements.aiQuestion.maxLength}`;
}

async function askAssistant() {
  const documentRecord = state.catalog.find((item) => item.id === state.selectedId);
  const question = elements.aiQuestion.value.trim();
  const proxyUrl = safeHttpUrl(config.aiProxyUrl);
  if (!documentRecord || !question || !proxyUrl || !config.aiEnabled) return;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
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

    elements.aiResponse.textContent = payload.answer.trim();
  } catch (error) {
    console.error("AI assistance is unavailable", error);
    elements.aiResponse.classList.add("is-error");
    elements.aiResponse.textContent = "AI assistance is unavailable. Open the official SDS PDF for authoritative safety information. For an active emergency, follow the site emergency plan.";
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
    elements.searchInput.value = "";
    elements.clearSearch.hidden = true;
    renderDepartmentFilters();
    renderLanguageFilters();
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
