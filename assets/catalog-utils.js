const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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
  const controlledFilename = /^[A-Za-z0-9][A-Za-z0-9._,'-]{0,190}\.pdf$/.test(document.file) && typeof document.pdfUrl === "string";
  if (!legacyFilename && !controlledFilename) return false;
  if (document.revisionDate != null && document.revisionDate !== "" && !isIsoDate(document.revisionDate)) return false;

  const optionalStrings = ["manufacturer", "productCode", "location", "language", "pdfUrl"];
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
      pdfUrl: document.pdfUrl?.trim() || "",
      hazards: Object.freeze((document.hazards || []).map((item) => item.trim()).filter(Boolean))
    }))
    .sort((left, right) => collator.compare(left.name, right.name));
}

export function getDepartments(documents) {
  return [...new Set(documents.map((document) => document.department).filter(Boolean))]
    .sort(collator.compare);
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
    if (department !== "All" && document.department !== department) return false;
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
