const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isValidDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;

  const requiredStrings = ["id", "name", "file", "department"];
  if (requiredStrings.some((key) => typeof document[key] !== "string" || !document[key].trim())) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.id)) return false;
  const legacyFilename = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/.test(document.file);
  // A controlled (intake-approved) filename is served via its own pdfUrl, so the file field is just a
  // label. The backend only strips filesystem-illegal characters, so it legitimately keeps parentheses,
  // spaces, & etc. (e.g. "UNASCO (M) SDN.BHD"). Accept any .pdf label that has a pdfUrl and is free of
  // path separators and traversal — do not reject on ordinary punctuation.
  const controlledFilename = typeof document.pdfUrl === "string"
    && /\.pdf$/i.test(document.file)
    && document.file.length <= 200
    && !document.file.includes("..")
    && !document.file.includes("/")
    && !document.file.includes("\\");
  if (!legacyFilename && !controlledFilename) return false;
  if (document.revisionDate != null && document.revisionDate !== "" && !isIsoDate(document.revisionDate)) return false;

  const optionalStrings = ["manufacturer", "productCode", "location", "language", "pdfUrl", "establishedDate", "expiryDate"];
  if (optionalStrings.some((key) => document[key] != null && typeof document[key] !== "string")) return false;
  if (document.documentType != null && !["SDS", "TDS", "Unverified"].includes(document.documentType)) return false;
  if (document.hazards != null && (!Array.isArray(document.hazards) || document.hazards.some((item) => typeof item !== "string"))) return false;

  return true;
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function sanitizeCatalog(documents) {
  if (!Array.isArray(documents)) return [];

  return documents
    .filter(isValidDocument)
    .map((document) => Object.freeze({
      id: document.id.trim(),
      name: document.name.trim(),
      file: document.file.trim(),
      department: document.department.trim(),
      revisionDate: document.revisionDate?.trim() || "",
      documentType: ["SDS", "TDS", "Unverified"].includes(document.documentType) ? document.documentType : "SDS",
      manufacturer: document.manufacturer?.trim() || "",
      productCode: document.productCode?.trim() || "",
      location: document.location?.trim() || "",
      language: document.language?.trim() || "",
      documentLanguage: ["en", "ms", "bilingual", "unknown"].includes(document.documentLanguage) ? document.documentLanguage : "unknown",
      isBilingual: Boolean(document.isBilingual),
      groupId: typeof document.groupId === "string" && document.groupId.trim() ? document.groupId.trim() : "",
      departments: Object.freeze(Array.isArray(document.departments) ? [...new Set(document.departments.map((value) => String(value).trim()).filter(Boolean))] : []),
      pdfUrl: document.pdfUrl?.trim() || "",
      establishedDate: document.establishedDate?.trim() || "",
      expiryDate: document.expiryDate?.trim() || "",
      hazards: Object.freeze((document.hazards || []).map((item) => item.trim()).filter(Boolean))
    }))
    .sort((left, right) => collator.compare(left.name, right.name));
}

// Collapse language variants that EHS has grouped (shared groupId) into one product, so an employee
// sees one record per product with a language choice. Ungrouped documents each stay their own
// single-variant product, so behaviour is unchanged until EHS actually links variants together.
export function buildProductGroups(documents) {
  const groups = new Map();
  const order = [];
  for (const documentRecord of documents) {
    const key = documentRecord.groupId || `solo:${documentRecord.id}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(documentRecord);
  }
  return order.map((key) => {
    const variants = groups.get(key);
    const representative = pickVariant(variants, "en") || variants[0];
    return { key, id: representative.id, name: representative.name, variants, languages: availableLanguages(variants), representative };
  });
}

// Employee languages a group can serve. A bilingual variant satisfies both English and Bahasa Melayu.
export function availableLanguages(variants) {
  const set = new Set();
  for (const variant of variants) {
    if (variant.documentLanguage === "bilingual" || variant.isBilingual) { set.add("en"); set.add("ms"); }
    else if (variant.documentLanguage === "en") set.add("en");
    else if (variant.documentLanguage === "ms") set.add("ms");
  }
  return [...set];
}

// Best variant for a requested language: an exact single-language match, else a bilingual variant
// (covers any language), else null when that language is not available.
export function pickVariant(variants, language) {
  return variants.find((variant) => variant.documentLanguage === language)
    || variants.find((variant) => variant.documentLanguage === "bilingual" || variant.isBilingual)
    || null;
}

export const EMPLOYEE_LANGUAGES = [{ code: "en", label: "English" }, { code: "ms", label: "Bahasa Melayu" }];

export function getDepartments(documents) {
  const names = documents.flatMap((document) => (document.departments && document.departments.length ? document.departments : [document.department]));
  return [...new Set(names.filter(Boolean))].sort(collator.compare);
}

export function getLanguages(documents) {
  return [...new Set(documents.map((document) => document.language).filter(Boolean))]
    .sort(collator.compare);
}

export function resolveLanguage(requested, languages) {
  if (!requested) return "All";
  return languages.find((language) => language.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en")) || "All";
}

// Display label for a stored language value. The catalog stores "Malay"; the
// facility refers to it as Bahasa Malaysia. English stays English.
export function languageLabel(language) {
  if (!language) return "";
  const normalized = language.trim().toLocaleLowerCase("en");
  if (normalized === "malay" || normalized === "bahasa melayu" || normalized === "bahasa malaysia" || normalized === "bm") {
    return "Bahasa Malaysia";
  }
  if (normalized === "english" || normalized === "en") return "English";
  return language.trim();
}

export function filterCatalog(documents, query = "", department = "All", language = "All") {
  const normalizedQuery = normalizeText(query);
  const terms = normalizedQuery.split(" ").filter(Boolean);

  return documents.filter((document) => {
    if (department !== "All" && document.department !== department && !(document.departments || []).includes(department)) return false;
    if (language !== "All" && document.language !== language) return false;
    if (terms.length === 0) return true;

    const searchableText = normalizeText([
      document.name,
      document.manufacturer,
      document.productCode,
      document.department,
      document.location,
      document.language,
      ...(document.hazards || [])
    ].join(" "));

    return terms.every((term) => searchableText.includes(term));
  });
}

export function formatRevisionDate(date, locale = "en") {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(parsed);
}

export function resolveDepartment(requested, departments) {
  if (!requested) return "All";
  return departments.find((department) => department.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en")) || "All";
}

export const SDS_VALIDITY_YEARS = 5;

export function addYears(isoDate, years) {
  if (!isIsoDate(isoDate)) return "";
  const [year, month, day] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(year + years, month - 1, day));
  if (target.getUTCMonth() !== month - 1) target.setUTCDate(0); // Feb 29 -> Feb 28
  return target.toISOString().slice(0, 10);
}

// Effective expiry for a document: an explicit expiryDate from the intake system,
// otherwise the revision date + 5 years. Empty string means it cannot be determined.
export function getExpiryDate(documentRecord) {
  if (isIsoDate(documentRecord?.expiryDate)) return documentRecord.expiryDate;
  return addYears(documentRecord?.revisionDate, SDS_VALIDITY_YEARS);
}

// Validity state for display: "valid", "expiring" (within warnDays, default 2
// months), "expired", or "unknown" when no usable date exists (never guessed).
export function validityStatus(documentRecord, now = new Date(), warnDays = 60) {
  const expiryDate = getExpiryDate(documentRecord);
  if (!expiryDate) return { state: "unknown", expiryDate: "" };
  const expiryMs = Date.parse(`${expiryDate}T00:00:00Z`);
  const todayMs = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (todayMs > expiryMs) return { state: "expired", expiryDate };
  if (expiryMs - todayMs <= warnDays * 86400000) return { state: "expiring", expiryDate };
  return { state: "valid", expiryDate };
}
