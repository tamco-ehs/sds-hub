import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "admin.html", "manifest.webmanifest", "service-worker.js", "robots.txt", "404.html"]) {
  await cp(path.join(root, file), path.join(output, file));
}

await cp(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });
await mkdir(path.join(output, "data"), { recursive: true });
await cp(path.join(root, "data", "sds-data.json"), path.join(output, "data", "sds-data.json"));

const outputPdfs = path.join(output, "pdfs");
await mkdir(outputPdfs, { recursive: true });
for (const entry of await readdir(path.join(root, "pdfs"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
    await cp(path.join(root, "pdfs", entry.name), path.join(outputPdfs, entry.name));
  }
}

await writeFile(path.join(output, ".nojekyll"), "", "utf8");

const catalog = JSON.parse(await readFile(path.join(root, "data", "sds-data.json"), "utf8"));
console.log(`Built production site with ${catalog.documents.length} catalog document(s) in ${path.relative(root, output)}.`);
