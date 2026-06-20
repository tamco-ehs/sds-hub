import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoDate, isValidDocument } from "../assets/catalog-utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireData = process.argv.includes("--require-data");
const errors = [];
const warnings = [];
const allowedFields = new Set([
  "id",
  "name",
  "file",
  "department",
  "revisionDate",
  "documentType",
  "manufacturer",
  "productCode",
  "location",
  "language",
  "hazards"
]);

const requiredSiteFiles = [
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "assets/app.js",
  "assets/catalog-utils.js",
  "assets/config.js",
  "assets/icon.svg",
  "assets/styles.css",
  "data/sds-data.json"
];

for (const relativePath of requiredSiteFiles) {
  if (!existsSync(path.join(root, relativePath))) errors.push(`Missing required site file: ${relativePath}`);
}

let catalog;
try {
  catalog = JSON.parse(await readFile(path.join(root, "data", "sds-data.json"), "utf8"));
} catch (error) {
  errors.push(`Catalog is not valid JSON: ${error.message}`);
  catalog = null;
}

if (catalog) {
  if (catalog.schemaVersion !== 1) errors.push("Catalog schemaVersion must equal 1.");
  if (!isIsoDate(catalog.updatedAt)) errors.push("Catalog updatedAt must be a real calendar date using YYYY-MM-DD.");
  if (!Array.isArray(catalog.documents)) errors.push("Catalog documents must be an array.");

  if (Array.isArray(catalog.documents)) {
    if (catalog.documents.length === 0) {
      const message = "Catalog is empty. Add approved manufacturer SDS PDFs before facility release.";
      if (requireData) errors.push(message);
      else warnings.push(message);
    }

    const seenIds = new Set();
    const seenFiles = new Set();

    for (const [index, document] of catalog.documents.entries()) {
      const label = document?.id || `record ${index + 1}`;
      if (!isValidDocument(document)) {
        errors.push(`${label}: record does not match the SDS schema.`);
        continue;
      }

      const unknownFields = Object.keys(document).filter((key) => !allowedFields.has(key));
      if (unknownFields.length) errors.push(`${label}: unknown fields: ${unknownFields.join(", ")}.`);
      if (seenIds.has(document.id)) errors.push(`${label}: duplicate document id.`);
      if (seenFiles.has(document.file)) errors.push(`${label}: duplicate PDF filename.`);
      seenIds.add(document.id);
      seenFiles.add(document.file);

      const pdfPath = path.join(root, "pdfs", document.file);
      if (!existsSync(pdfPath)) {
        errors.push(`${label}: missing pdfs/${document.file}.`);
        continue;
      }

      const header = await readFile(pdfPath).then((buffer) => buffer.subarray(0, 5).toString("ascii"));
      if (header !== "%PDF-") errors.push(`${label}: pdfs/${document.file} does not have a valid PDF signature.`);
    }

    const files = await readdir(path.join(root, "pdfs"), { withFileTypes: true });
    const unregisteredPdfs = files
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf") && !seenFiles.has(entry.name))
      .map((entry) => entry.name);
    if (unregisteredPdfs.length) errors.push(`Unregistered PDF files: ${unregisteredPdfs.join(", ")}.`);
  }
}

const textFiles = await collectTextFiles(root);
const secretPatterns = [
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

for (const filePath of textFiles) {
  const content = await readFile(filePath, "utf8");
  for (const check of secretPatterns) {
    if (check.pattern.test(content)) errors.push(`${path.relative(root, filePath)}: possible ${check.name} detected.`);
    check.pattern.lastIndex = 0;
  }
}

const configSource = await readFile(path.join(root, "assets", "config.js"), "utf8");
if (/aiEnabled:\s*true/.test(configSource) && /aiProxyUrl:\s*"\s*"/.test(configSource)) {
  errors.push("AI is enabled but aiProxyUrl is empty.");
}

const indexSource = await readFile(path.join(root, "index.html"), "utf8");
validateHtmlShell(indexSource);

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.error(`\nValidation failed with ${errors.length} error(s).`);
  process.exit(1);
}

console.log(`Validated ${catalog?.documents?.length || 0} catalog document(s); no release-blocking errors found.`);

function validateHtmlShell(html) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) errors.push(`index.html has duplicate ids: ${duplicateIds.join(", ")}.`);

  const idSet = new Set(ids);
  const singleReferences = [...html.matchAll(/\b(?:for|aria-describedby|aria-labelledby)="([^"]+)"/g)]
    .flatMap((match) => match[1].split(/\s+/));
  const missingReferences = [...new Set(singleReferences.filter((id) => !idSet.has(id)))];
  if (missingReferences.length) errors.push(`index.html references missing ids: ${missingReferences.join(", ")}.`);

  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1] || "";
  if (!csp) errors.push("index.html is missing its Content Security Policy.");
  if (/unsafe-inline|unsafe-eval/i.test(csp)) errors.push("Content Security Policy must not allow unsafe-inline or unsafe-eval.");

  const blankTargets = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gi)].map((match) => match[0]);
  if (blankTargets.some((tag) => !/\brel="[^"]*noopener[^"]*"/i.test(tag))) {
    errors.push("Every target=_blank link must include rel=noopener.");
  }

  const localAssets = [...html.matchAll(/\b(?:href|src)="(\.\/[^"]+)"/g)]
    .map((match) => match[1].split(/[?#]/)[0])
    .filter((value) => value !== "./");
  for (const asset of new Set(localAssets)) {
    if (!existsSync(path.join(root, asset.slice(2)))) errors.push(`index.html references missing local asset: ${asset}.`);
  }
}

async function collectTextFiles(directory) {
  const ignoredDirectories = new Set([".git", "dist", "node_modules", ".wrangler"]);
  const textExtensions = new Set([".html", ".js", ".json", ".md", ".toml", ".txt", ".yml", ".yaml", ".webmanifest"]);
  const results = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) results.push(...await collectTextFiles(fullPath));
    } else if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }

  return results;
}
