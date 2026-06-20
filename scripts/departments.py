"""Bulk-assign departments to catalog documents via a reviewable CSV.

Departments are the facility owner's decision (they reflect where each chemical is
actually used). This tool does NOT decide for you: it exports every document to a
spreadsheet with a *suggested* department you can correct, then applies your edits.

Workflow:
    python scripts/departments.py export      # write data/departments.csv (suggestions)
    #  -> open data/departments.csv in Excel, fix the "department" column, save
    python scripts/departments.py apply       # write your departments into the catalog

The CSV uses UTF-8 with BOM so Excel shows accents (™, ü) correctly.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "sds-data.json"
CSV_PATH = ROOT / "data" / "departments.csv"
FIELDS = ["id", "name", "manufacturer", "documentType", "language", "department"]

# Ordered keyword -> department suggestions. First match wins, so put the more
# specific buckets before the broad "Maintenance & Lubricants" one.
RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Welding & Industrial Gas", (
        "nitrogen", "oksigen", "oxygen", "carbon dioxide", "karbon dioksida", "argon",
        "argoshield", "corgon", "helium", "propane", "lpg", "liquefied petroleum",
        "sulfur hexafluor", "sulphur hexafluor", "sulfur hexafluorida", "sf 6", "sf6",
        "acetylene", "specshield", "termampat", "compressed", "refrigerated liquid",
    )),
    ("Surface Treatment & Plating", (
        "phosphat", "de-ruster", "deruster", "degreas", "pickling", "nitric acid",
        "oxide film", "electrolyte", "passivat", "spu ", "spu-",
    )),
    ("Laboratory & QC", (
        "buffer", "indicator", "bromophenol", "phenolphthalein", "sodium hydroxide",
        "sodium hyrdroxide", "sulfuric acid", "sulphuric acid", "ph4", "ph7", "ph10",
        "methylated spirit", "methanol", "molsiv", "adsorbent", "ysi-",
    )),
    ("Pest Control & Sanitation", (
        "abate", "fendona", "maxxthor", "weatherblok", "termitic", "insecticid",
        "disinfectant", "distel", "anti-foam", "anti foam",
    )),
    ("Paint & Coating", (
        "paint", "thinner", "lacquer", "primer", " pu ", "pu ", "ral ", "gloss",
        "enamel", "aerosol", "tamco", "munsel", "dewa", "zinc rich", "silkscreen",
        "pigment", "tg gloss", "hp dp", "cutler", "witch grey", "krystal", "f2 gp",
    )),
    ("Adhesives & Sealants", (
        "loctite", "aron alpha", "aron", "epoxy", "putty", "sealant", "adhesive",
        "retaining", "thread sealant", "vt-210", "voratron", "cyanoacrylate",
        "spe1490", "taseto", "solder", "flux", "ks237", "ks238", "spi ",
    )),
    ("Cleaning & Solvents", (
        "solvent", "cleaner", "cleaning", "as 88", "as-88", "as88", "white spirit",
        "rubbing compound", "polish", "tarn-x", "super 99", "wax", "gold & silver",
        "leak detection",
    )),
    ("Maintenance & Lubricants", (
        "grease", "oil", "lubric", "moly", "alvania", "spheerol", "uniplex", "inplex",
        "nautilus", "hydraulic", "wd-40", "wd 40", "isoflex", "kluber", "klüber",
        "beralfa", "ampress", "celcon", "celplex", "amtec", "robotik", "g2163", "epl",
        "topas", "precision", "pennzoil", "toshiba", "spirit", "celcon", "nmp",
    )),
]


def suggest(doc: dict) -> str:
    hay = f"{doc.get('name', '')} {doc.get('manufacturer', '')} {doc.get('id', '')}".casefold()
    for department, keywords in RULES:
        if any(k in hay for k in keywords):
            return department
    return "Unassigned"


def export() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    docs = catalog["documents"]
    counts: dict[str, int] = {}
    with CSV_PATH.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        for doc in docs:
            current = doc.get("department", "")
            dept = current if current and current != "Unassigned" else suggest(doc)
            counts[dept] = counts.get(dept, 0) + 1
            writer.writerow({
                "id": doc["id"],
                "name": doc.get("name", ""),
                "manufacturer": doc.get("manufacturer", ""),
                "documentType": doc.get("documentType", "SDS"),
                "language": doc.get("language", ""),
                "department": dept,
            })
    print(f"Wrote {len(docs)} rows to {CSV_PATH.relative_to(ROOT)} (UTF-8 BOM, open in Excel).")
    print("Suggested distribution (edit the 'department' column to correct):")
    for dept, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {n:4}  {dept}")
    return 0


def apply() -> int:
    if not CSV_PATH.exists():
        print(f"Missing {CSV_PATH.relative_to(ROOT)}. Run 'export' first.", file=sys.stderr)
        return 2
    rows: dict[str, str] = {}
    with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            doc_id = (row.get("id") or "").strip()
            dept = (row.get("department") or "").strip()
            if doc_id:
                rows[doc_id] = dept or "Unassigned"

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    changed = 0
    for doc in catalog["documents"]:
        new = rows.get(doc["id"])
        if new is not None and new != doc.get("department"):
            doc["department"] = new
            changed += 1

    catalog["updatedAt"] = date.today().isoformat()
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    departments = sorted({d.get("department", "") for d in catalog["documents"]})
    print(f"Updated {changed} department(s). Catalog now uses: {', '.join(departments)}")
    print("Run npm test before release.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Export/apply catalog departments via CSV.")
    parser.add_argument("mode", choices=["export", "apply"], help="export suggestions, or apply your edits")
    args = parser.parse_args()
    return export() if args.mode == "export" else apply()


if __name__ == "__main__":
    raise SystemExit(main())
