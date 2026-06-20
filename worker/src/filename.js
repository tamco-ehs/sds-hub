const ILLEGAL_FILENAME_CHARS = /[:/\\*?"“”<>|\r\n\t]+/g;

export function sanitizeFilenamePart(value, fallback) {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(ILLEGAL_FILENAME_CHARS, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
  return cleaned || fallback;
}

export function normalizeLanguageCode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const known = {
    english: "EN",
    en: "EN",
    malay: "MS",
    bahasa: "MS",
    "bahasa melayu": "MS",
    ms: "MS",
    chinese: "ZH",
    mandarin: "ZH",
    zh: "ZH"
  };
  return known[normalized] || sanitizeFilenamePart(normalized.toUpperCase(), "LANG-Unknown").slice(0, 12);
}

export function generateApprovedFilename(metadata) {
  const product = sanitizeFilenamePart(metadata.product_name || metadata.trade_name, "Product-Unknown");
  const supplier = sanitizeFilenamePart(metadata.supplier || metadata.manufacturer, "Supplier-Unknown");
  const revision = metadata.revision_date
    ? normalizeRevisionForFilename(metadata.revision_date)
    : "Rev-Date-Unknown";
  const language = normalizeLanguageCode(metadata.language);
  const base = `SDS_${product}_${supplier}_${revision}_${language}`;
  return `${base.slice(0, 190).replace(/[._ ]+$/g, "")}.pdf`;
}

export function normalizeRevisionForFilename(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Rev-Date-Unknown";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso && isRealDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return raw;

  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  const cleaned = raw.replace(/\.(?=\s|\d)/g, "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const monthFirst = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  const dayFirst = cleaned.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const match = monthFirst || dayFirst;
  if (match) {
    const monthName = (monthFirst ? match[1] : match[2]).toLowerCase();
    const month = months[monthName];
    const day = Number(monthFirst ? match[2] : match[1]);
    const year = Number(match[3]);
    if (month && isRealDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return sanitizeFilenamePart(raw, "Rev-Date-Unknown");
}

function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
