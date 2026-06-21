import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "admin.html", "reset-password.html", "manifest.webmanifest", "service-worker.js", "robots.txt", "404.html"]) {
  await cp(path.join(root, file), path.join(output, file));
}

await cp(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });
await mkdir(path.join(output, "data"), { recursive: true });
await cp(path.join(root, "data", "sds-data.json"), path.join(output, "data", "sds-data.json"));

const catalog = JSON.parse(await readFile(path.join(root, "data", "sds-data.json"), "utf8"));
const outputPdfs = path.join(output, "pdfs");
await mkdir(outputPdfs, { recursive: true });
// Publish only catalog-registered PDFs; loose/staged PDFs in pdfs/ are intentionally not published.
for (const document of catalog.documents) {
  const source = path.join(root, "pdfs", document.file);
  if (existsSync(source)) await cp(source, path.join(outputPdfs, document.file));
}

await writeFile(path.join(output, ".nojekyll"), "", "utf8");

console.log(`Built production site with ${catalog.documents.length} catalog document(s) in ${path.relative(root, output)}.`);
