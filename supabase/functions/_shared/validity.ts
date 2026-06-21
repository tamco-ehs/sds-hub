// SDS validity detection. The "established" date is the latest SDS revision date,
// falling back to the issue/preparation date. Expiry is established + 5 years.
// When no date can be parsed confidently, validity is unknown (never guessed).

export const SDS_VALIDITY_YEARS = 5;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

function isRealDate(year: number, month: number, day: number) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function iso(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Parse a free-text date into an ISO string, or null if not confidently a real date.
// Numeric DD/MM/YYYY is read day-first (Commonwealth/Malaysian convention).
export function toIsoDate(value: unknown): string | null {
  const raw = String(value ?? "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1").trim();
  if (!raw) return null;

  const isoMatch = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const [y, m, d] = [Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])];
    if (isRealDate(y, m, d)) return iso(y, m, d);
  }

  const dayMonthYear = raw.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (dayMonthYear) {
    const month = MONTHS[dayMonthYear[2].toLowerCase()];
    const [d, y] = [Number(dayMonthYear[1]), Number(dayMonthYear[3])];
    if (month && isRealDate(y, month, d)) return iso(y, month, d);
  }

  const monthDayYear = raw.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (monthDayYear) {
    const month = MONTHS[monthDayYear[1].toLowerCase()];
    const [d, y] = [Number(monthDayYear[2]), Number(monthDayYear[3])];
    if (month && isRealDate(y, month, d)) return iso(y, month, d);
  }

  const monthYear = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    const y = Number(monthYear[2]);
    if (month && isRealDate(y, month, 1)) return iso(y, month, 1);
  }

  const numeric = raw.match(/\b(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})\b/);
  if (numeric) {
    let [a, b, c] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
    if (a > 31) { // YYYY/MM/DD
      if (isRealDate(a, b, c)) return iso(a, b, c);
    } else { // DD/MM/YYYY, day-first
      if (c < 100) c += c < 70 ? 2000 : 1900;
      if (isRealDate(c, b, a)) return iso(c, b, a);
    }
  }
  return null;
}

export function addYears(isoDate: string, years: number): string | null {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  let [y, m, d] = [Number(match[1]) + years, Number(match[2]), Number(match[3])];
  if (!isRealDate(y, m, d)) d = 28; // Feb 29 -> Feb 28 in a non-leap target year
  return iso(y, m, d);
}

// Determine establishment (effective) date and expiry from the extracted dates.
export function computeValidity(issueDate: unknown, revisionDate: unknown, years = SDS_VALIDITY_YEARS) {
  const revision = toIsoDate(revisionDate);
  const issue = toIsoDate(issueDate);
  const established = revision || issue;
  if (!established) return { establishedDate: null as string | null, expiryDate: null as string | null, basis: null as string | null };
  return { establishedDate: established, expiryDate: addYears(established, years), basis: revision ? "revision" : "issue" };
}
