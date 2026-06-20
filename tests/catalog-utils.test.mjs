import assert from "node:assert/strict";
import test from "node:test";
import {
  filterCatalog,
  formatRevisionDate,
  getDepartments,
  isIsoDate,
  isValidDocument,
  normalizeText,
  resolveDepartment,
  sanitizeCatalog
} from "../assets/catalog-utils.js";

const fixtures = [
  {
    id: "acetone-acs",
    name: "Acetone, ACS Grade",
    file: "acetone-acs-2026-01-15.pdf",
    department: "Laboratory",
    revisionDate: "2026-01-15",
    documentType: "SDS",
    manufacturer: "Example Chemical Co.",
    productCode: "AC-100",
    location: "Solvent cabinet",
    language: "English",
    hazards: ["Flammable", "Eye irritation"]
  },
  {
    id: "floor-cleaner",
    name: "Neutral Floor Cleaner",
    file: "floor-cleaner-2025-09-01.pdf",
    department: "Janitorial",
    revisionDate: "2025-09-01",
    documentType: "SDS",
    manufacturer: "Example Supply",
    productCode: "FC-20",
    hazards: []
  }
];

test("normalizes punctuation and accents for search", () => {
  assert.equal(normalizeText("  Crème #42 / Cleaner  "), "creme 42 cleaner");
});

test("validates safe catalog records", () => {
  assert.equal(isValidDocument(fixtures[0]), true);
  assert.equal(isValidDocument({ ...fixtures[0], file: "../secret.pdf" }), false);
  assert.equal(isValidDocument({ ...fixtures[0], id: "Acetone" }), false);
  assert.equal(isValidDocument({ ...fixtures[0], revisionDate: "15/01/2026" }), false);
  assert.equal(isValidDocument({ ...fixtures[0], revisionDate: "2026-02-31" }), false);
  assert.equal(isValidDocument({ ...fixtures[0], revisionDate: "" }), true);
  assert.equal(isValidDocument({
    ...fixtures[0],
    id: "f0e6f00c-c039-4fb4-85b7-b46c1928ffe1",
    file: "SDS_WD-40_Aerosol_WD-40_Company_2023-06-26_EN.pdf",
    pdfUrl: "https://github.com/izzulwork1/sds-hub/releases/download/sds-approved/example.pdf"
  }), true);
  assert.equal(isValidDocument({ ...fixtures[0], file: "SDS_Unsafe/Path.pdf", pdfUrl: "https://example.com/file.pdf" }), false);
});

test("rejects impossible ISO calendar dates", () => {
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2025-02-29"), false);
});

test("sanitizes and alphabetizes records", () => {
  const sanitized = sanitizeCatalog([fixtures[1], fixtures[0], { invalid: true }]);
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].id, "acetone-acs");
  assert.equal(Object.isFrozen(sanitized[0]), true);
});

test("filters by department and every search term", () => {
  const catalog = sanitizeCatalog(fixtures);
  assert.deepEqual(filterCatalog(catalog, "acetone flammable", "Laboratory").map((item) => item.id), ["acetone-acs"]);
  assert.deepEqual(filterCatalog(catalog, "AC-100", "All").map((item) => item.id), ["acetone-acs"]);
  assert.deepEqual(filterCatalog(catalog, "cleaner", "Laboratory"), []);
});

test("extracts sorted unique departments and resolves routes case-insensitively", () => {
  const departments = getDepartments(sanitizeCatalog(fixtures));
  assert.deepEqual(departments, ["Janitorial", "Laboratory"]);
  assert.equal(resolveDepartment("laboratory", departments), "Laboratory");
  assert.equal(resolveDepartment("missing", departments), "All");
});

test("formats revision dates without timezone drift", () => {
  assert.equal(formatRevisionDate("2026-01-15", "en-US"), "Jan 15, 2026");
});
