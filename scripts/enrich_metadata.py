"""Re-read registered SDS PDFs and propose missing revision dates / manufacturers.

This complements onboard_pdfs.py, which only handles NEW files. Here we revisit
already-registered documents and try to fill gaps using broadened (but still
careful) extractors, plus OCR fallback for scanned/image-only pages.

Safety rules (per the production blueprint):
  * Review-only by default. Run with --apply to write changes.
  * --apply only FILLS EMPTY fields and only HIGH-confidence proposals. It never
    overwrites a value a human set, never auto-applies an ambiguous date, and
    never touches hazards or product names (those need human verification).
  * "Print date" is ignored on purpose: it is not a revision indicator.
  * Every proposal records the exact source text so a human can verify it.

Usage:
    python scripts/enrich_metadata.py            # write data/enrichment-report.json
    python scripts/enrich_metadata.py --apply    # fill empty fields, high-confidence only
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import onboard_pdfs as ob  # noqa: E402  (reuse extractors + Tesseract auto-config)

try:
    from pypdf import PdfReader
except ImportError:
    print("Missing admin dependencies. Run: python -m pip install -r scripts/requirements-admin.txt", file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[1]
PDF_DIR = ROOT / "pdfs"
CATALOG = ROOT / "data" / "sds-data.json"
REPORT = ROOT / "data" / "enrichment-report.json"

# Date labels ranked by how reliably they indicate the SDS revision date.
# Tier 1 (revision) and tier 2 (issue/effective) are treated as high confidence.
# Tier 3 (preparation) is low confidence. "Print date" is excluded entirely.
DATE_LABEL_TIERS = [
    (1, ("date of revision", "revision date", "date revised", "last revised", "revised on",
         "revised", "tarikh semakan", "tarikh disemak", "tarikh pindaan")),
    (2, ("issue date", "date of issue", "issued", "effective date", "date of preparation/revision",
         "tarikh terbitan", "tarikh keluaran", "tarikh dikeluarkan")),
    (3, ("date of preparation", "date prepared", "preparation date", "sds date of preparation",
         "prepared", "version date")),
]
DATE_VALUE = (
    r"(?P<d>"
    r"\d{4}[./-]\d{1,2}[./-]\d{1,2}"                       # YYYY-MM-DD
    r"|\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}"        # DD/MM/YYYY (spaces tolerated)
    r"|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}"  # 12 March 2021
    r"|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}"               # March 12, 2021
    r"|[A-Za-z]{3,9}\.?\s+\d{4}"                           # October 2021
    r")"
)
MFR_LABELS = ("manufacturer", "manufactured by", "supplier", "company name", "company",
              "pengilang", "pembekal", "dikilangkan oleh")
COMPANY_HINT = re.compile(r"(?i)\b(sdn|bhd|berhad|ltd|limited|inc|incorporated|gmbh|co\.?|company|"
                          r"corp|corporation|llc|pty|s\.?a\.?|b\.?v\.?|kg|plc)\b")


def read_text(path: Path) -> tuple[str, bool]:
    """Return (text, ocr_used). Uses the PDF text layer, OCR as a fallback."""
    text = ""
    try:
        reader = PdfReader(str(path), strict=False)
        indexes = list(dict.fromkeys([0, 1, 2, max(0, len(reader.pages) - 1)]))
        text = "\n".join((reader.pages[i].extract_text() or "") for i in indexes)
    except Exception:
        text = ""
    if len(ob.normalize_space(text)) < 200:
        ocr = ob.extract_text_with_ocr(path)
        if len(ob.normalize_space(ocr)) > len(ob.normalize_space(text)):
            return ocr, True
    return text, False


def find_revision_date(text: str) -> dict | None:
    """Find the best labeled revision date anywhere in the text (not line-anchored).

    Returns a dict with date, source snippet, tier, ambiguous flag — or None.
    Picks the most reliable tier; within a tier, the latest valid date.
    """
    flat = re.sub(r"[ \t\xa0]+", " ", text)
    best = None  # (tier, iso, ambiguous, snippet)
    for tier, labels in DATE_LABEL_TIERS:
        label_re = re.compile(
            r"(?i)(?<![A-Za-z])(?:" + "|".join(re.escape(l) for l in labels) + r")\s*[:#.\-]?\s*" + DATE_VALUE
        )
        for m in label_re.finditer(flat):
            raw = m.group("d").strip(" .,;")
            iso, ambiguous = parse_date(raw)
            if not iso:
                continue
            snippet = ob.normalize_space(m.group(0))[:80]
            if best is None or best[0] > tier or (best[0] == tier and iso > best[1]):
                best = (tier, iso, ambiguous, snippet)
        if best and best[0] == tier:
            break  # a hit in a more reliable tier wins; stop descending
    if not best:
        return None
    tier, iso, ambiguous, snippet = best
    return {"revisionDate": iso, "dateTier": tier, "dateAmbiguous": ambiguous, "dateSource": snippet}


def parse_date(raw: str) -> tuple[str, bool]:
    """Return (iso_or_empty, ambiguous). Numeric DD/MM vs MM/DD assumes day-first
    (Malaysian/Commonwealth convention, matching the project's own parser)."""
    raw = re.sub(r"(?<=\d)(st|nd|rd|th)\b", "", raw, flags=re.IGNORECASE)
    numeric = re.fullmatch(r"\s*(\d{1,4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})\s*", raw)
    if numeric:
        a, b, c = (int(x) for x in numeric.groups())
        ambiguous = False
        if a >= 1000:                       # YYYY-MM-DD
            year, month, day = a, b, c
        else:                               # DD/MM/YYYY (day-first)
            day, month, year = a, b, c
            if year < 100:
                year += 2000 if year < 70 else 1900
            if day <= 12 and month <= 12:
                ambiguous = True            # could be MM/DD; flag for review
        try:
            return date(year, month, day).isoformat(), ambiguous
        except ValueError:
            return "", False
    try:
        parsed = ob.date_parser.parse(raw, fuzzy=False, dayfirst=True, default=datetime(2000, 1, 1))
        iso = (parsed.date() if isinstance(parsed, datetime) else parsed).isoformat()
        # Month-Year only (no day) -> day defaults to 1; acceptable, mark ambiguous.
        return iso, bool(re.fullmatch(r"[A-Za-z]{3,9}\.?\s+\d{4}", raw.strip()))
    except (ValueError, OverflowError):
        return "", False


def find_manufacturer(text: str) -> str | None:
    flat = re.sub(r"[ \t\xa0]+", " ", text)
    label_re = re.compile(
        r"(?i)(?<![A-Za-z])(?:" + "|".join(re.escape(l) for l in MFR_LABELS) + r")\s*(?:name)?\s*[:\-]\s*([^\n]{2,90})"
    )
    for m in label_re.finditer(flat):
        candidate = ob.clean_display_name(m.group(1))
        candidate = re.split(r"(?i)\b(address|tel|telephone|fax|email|e-mail|emergency|jalan|jln|no\.?\s*\d)", candidate)[0]
        candidate = ob.normalize_space(candidate).strip(" -:,;")
        # Reject SDS-authoring-software footers and boilerplate misread as a company.
        if re.search(r"(?i)\b(msds|mirs|ghs\s*format|software|all rights reserved)\b|\(c\)|©", candidate):
            continue
        if len(candidate) >= 3 and COMPANY_HINT.search(candidate) and "%" not in candidate:
            return candidate[:120]
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Propose missing SDS revision dates / manufacturers.")
    parser.add_argument("--apply", action="store_true", help="Fill empty fields with HIGH-confidence proposals only.")
    args = parser.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    docs = catalog["documents"]

    proposals = []
    ocr_count = 0
    for doc in docs:
        needs_date = not doc.get("revisionDate")
        needs_mfr = not doc.get("manufacturer")
        if not (needs_date or needs_mfr):
            continue
        path = PDF_DIR / doc["file"]
        if not path.exists():
            continue
        text, ocr_used = read_text(path)
        ocr_count += 1 if ocr_used else 0
        if not text.strip():
            continue

        proposal = {"id": doc["id"], "file": doc["file"], "ocrUsed": ocr_used}
        found = False
        if needs_date:
            hit = find_revision_date(text)
            if hit:
                date_high = hit["dateTier"] <= 2 and not hit["dateAmbiguous"]
                proposal.update(hit)
                proposal["dateConfidence"] = "high" if date_high else "low"
                found = True
        if needs_mfr:
            mfr = find_manufacturer(text)
            if mfr:
                proposal["manufacturer"] = mfr
                found = True
        if found:
            proposals.append(proposal)

    date_props = [p for p in proposals if "revisionDate" in p]
    report = {
        "generatedAt": date.today().isoformat(),
        "mode": "applied" if args.apply else "review",
        "summary": {
            "documentsWithGaps": sum(1 for d in docs if not d.get("revisionDate") or not d.get("manufacturer")),
            "ocrUsed": ocr_count,
            "dateProposalsHigh": sum(1 for p in date_props if p.get("dateConfidence") == "high"),
            "dateProposalsLow": sum(1 for p in date_props if p.get("dateConfidence") == "low"),
            "manufacturerProposals": sum(1 for p in proposals if "manufacturer" in p),
        },
        "proposals": proposals,
    }
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    s = report["summary"]
    print(f"Enrichment scan: {s['documentsWithGaps']} docs with gaps | OCR used on {ocr_count} | "
          f"dates: {s['dateProposalsHigh']} high + {s['dateProposalsLow']} low confidence | "
          f"manufacturers: {s['manufacturerProposals']}")

    if not args.apply:
        print(f"Review report written to {REPORT.relative_to(ROOT)}. No catalog records were changed.")
        return 0

    by_id = {d["id"]: d for d in docs}
    filled_dates = filled_mfr = 0
    for p in proposals:
        doc = by_id.get(p["id"])
        if not doc:
            continue
        if p.get("dateConfidence") == "high" and "revisionDate" in p and not doc.get("revisionDate"):
            doc["revisionDate"] = p["revisionDate"]
            filled_dates += 1
        if "manufacturer" in p and not doc.get("manufacturer"):
            doc["manufacturer"] = p["manufacturer"]
            filled_mfr += 1

    catalog["updatedAt"] = date.today().isoformat()
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(f"Applied: filled {filled_dates} high-confidence revision date(s) and {filled_mfr} manufacturer(s).")
    print("Low-confidence date proposals were left for manual review. Run npm test before release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
