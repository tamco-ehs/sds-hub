"""Scan, deduplicate, rename, and register SDS PDFs.

Run without --apply to generate a review report only. Run with --apply after
reviewing data/onboarding-report.json. Files are never deleted: exact duplicate
copies are moved to pdfs/archive/duplicates and files that cannot be identified
as an SDS are moved to pdfs/incoming-review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

try:
    from dateutil import parser as date_parser
    from pypdf import PdfReader
except ImportError:
    print(
        "Missing admin dependencies. Run: "
        "python -m pip install -r scripts/requirements-admin.txt",
        file=sys.stderr,
    )
    raise SystemExit(2)

try:
    import pypdfium2
    import pytesseract
except ImportError:
    pypdfium2 = None
    pytesseract = None


def _configure_tesseract() -> None:
    """Point pytesseract at a local Tesseract install when it is not on PATH.

    The UB-Mannheim Windows installer does not add itself to PATH by default,
    so check the standard install locations. This keeps OCR working without a
    shell restart or manual PATH edit, on this machine and future ones.
    """
    if pytesseract is None or shutil.which("tesseract"):
        return
    import os

    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/opt/homebrew/bin/tesseract",
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            pytesseract.pytesseract.tesseract_cmd = candidate
            return


_configure_tesseract()


ROOT = Path(__file__).resolve().parents[1]
PDF_DIR = ROOT / "pdfs"
CATALOG_PATH = ROOT / "data" / "sds-data.json"
REPORT_PATH = ROOT / "data" / "onboarding-report.json"
DUPLICATE_DIR = PDF_DIR / "archive" / "duplicates"
REVIEW_DIR = PDF_DIR / "incoming-review"

PDF_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$")
SDS_MARKERS = (
    "safety data sheet",
    "material safety data sheet",
    "chemical safety data sheet",
    "helaian data keselamatan",
    "risalah data keselamatan",
    "lembaran data keselamatan",
)

NAME_PATTERNS = [
    re.compile(
        r"(?im)^\s*(?:product name|trade name|product identifier|material name|"
        r"commercial product name|nama produk|nama dagangan)\s*(?:and code)?\s*[:\-]\s*"
        r"([^\n]{2,140})\s*$"
    ),
    re.compile(
        r"(?im)^\s*(?:product name|trade name|product identifier|material name|"
        r"nama produk|nama dagangan)\s*$\s*^\s*([^\n]{2,140})\s*$"
    ),
]

DATE_LABELS = (
    "revision date",
    "date of revision",
    "revised on",
    "last revised",
    "sds date of preparation",
    "date of preparation",
    "preparation date",
    "date prepared",
    "issue date",
    "date of issue",
    "version date",
    "effective date",
    "tarikh semakan",
    "tarikh disemak",
    "tarikh terbitan",
)
DATE_PATTERN = re.compile(
    rf"(?im)^\s*(?:{'|'.join(re.escape(label) for label in DATE_LABELS)})\s*[:\-]?\s*"
    r"([A-Za-z]{3,10}\.?\s+\d{1,2},?\s+\d{4}|"
    r"\d{1,2}\s+[A-Za-z]{3,10}\.?\s+\d{4}|"
    r"\d{4}[./-]\d{1,2}[./-]\d{1,2}|"
    r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4})"
)

MANUFACTURER_PATTERN = re.compile(
    r"(?im)^\s*(?:manufacturer|manufactured by|supplier|company|pengilang|pembekal)"
    r"\s*[:\-]\s*([^\n]{2,140})\s*$"
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare root-level PDFs for the SDS catalog.")
    parser.add_argument("--apply", action="store_true", help="Apply reviewed moves, renames, and catalog additions.")
    parser.add_argument("--department", default="Unassigned", help="Default department for newly registered PDFs.")
    args = parser.parse_args()

    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    existing_documents = catalog.get("documents", [])
    for document in existing_documents:
        document.setdefault("documentType", "SDS")
    existing_files = {item["file"].casefold() for item in existing_documents}
    existing_ids = {item["id"].casefold() for item in existing_documents}

    root_pdfs = sorted(
        (path for path in PDF_DIR.iterdir() if path.is_file() and path.suffix.casefold() == ".pdf"),
        key=lambda path: path.name.casefold(),
    )
    hashes = {path: sha256(path) for path in root_pdfs}
    by_hash: dict[str, list[Path]] = defaultdict(list)
    for path, digest in hashes.items():
        by_hash[digest].append(path)

    canonical_paths: list[Path] = []
    duplicate_paths: list[tuple[Path, Path]] = []
    for paths in by_hash.values():
        registered = [path for path in paths if path.name.casefold() in existing_files]
        canonical = registered[0] if registered else choose_canonical(paths)
        canonical_paths.append(canonical)
        duplicate_paths.extend((path, canonical) for path in paths if path != canonical)

    planned_names = set(existing_files)
    planned_ids = set(existing_ids)
    proposals = []
    review_items = []

    for path in sorted(canonical_paths, key=lambda item: item.name.casefold()):
        if path.name.casefold() in existing_files:
            continue

        metadata = inspect_pdf(path)
        if metadata["status"] != "ready":
            review_items.append(metadata)
            continue

        base_id = slugify(metadata["name"]) or slugify(path.stem) or "unnamed-sds"
        language_code = {"Malay": "ms", "English": "en"}.get(metadata["language"], "und")
        candidate_id = base_id
        if candidate_id.casefold() in planned_ids:
            candidate_id = f"{base_id}-{language_code}"
        if candidate_id.casefold() in planned_ids and metadata["revisionDate"]:
            candidate_id = f"{candidate_id}-{metadata['revisionDate']}"
        candidate_id = unique_token(candidate_id, planned_ids)
        planned_ids.add(candidate_id.casefold())

        date_token = metadata["revisionDate"] or "undated"
        filename = unique_filename(f"{candidate_id}-{date_token}.pdf", planned_names)
        planned_names.add(filename.casefold())

        record = {
            "id": candidate_id,
            "name": metadata["name"],
            "file": filename,
            "department": args.department.strip() or "Unassigned",
            "revisionDate": metadata["revisionDate"],
            "documentType": metadata["documentType"],
            "language": metadata["language"],
            "hazards": [],
        }
        if metadata["manufacturer"]:
            record["manufacturer"] = metadata["manufacturer"]

        proposals.append(
            {
                "originalFile": path.name,
                "newFile": filename,
                "nameSource": metadata["nameSource"],
                "dateSource": metadata["dateSource"],
                "record": record,
            }
        )

    report = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "mode": "apply" if args.apply else "review",
        "summary": {
            "rootPdfFiles": len(root_pdfs),
            "uniquePdfContent": len(canonical_paths),
            "alreadyRegistered": sum(path.name.casefold() in existing_files for path in canonical_paths),
            "proposedRegistrations": len(proposals),
            "exactDuplicateCopies": len(duplicate_paths),
            "needsManualReview": len(review_items),
        },
        "proposals": proposals,
        "duplicates": [
            {"file": duplicate.name, "sameAs": canonical.name}
            for duplicate, canonical in duplicate_paths
        ],
        "manualReview": review_items,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    if not args.apply:
        print_summary(report)
        print(f"Review report written to {REPORT_PATH.relative_to(ROOT)}. No PDFs or catalog records were changed.")
        return 0

    DUPLICATE_DIR.mkdir(parents=True, exist_ok=True)
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)

    for duplicate, _canonical in duplicate_paths:
        move_preserving(duplicate, DUPLICATE_DIR / duplicate.name)

    for item in review_items:
        source = PDF_DIR / item["originalFile"]
        if source.exists():
            move_preserving(source, REVIEW_DIR / source.name)

    for proposal in proposals:
        source = PDF_DIR / proposal["originalFile"]
        destination = PDF_DIR / proposal["newFile"]
        if source != destination:
            if destination.exists():
                raise RuntimeError(f"Refusing to overwrite {destination}")
            source.rename(destination)
        existing_documents.append(proposal["record"])

    existing_documents.sort(key=lambda item: (item.get("name", "").casefold(), item.get("language", "").casefold()))
    catalog["updatedAt"] = date.today().isoformat()
    catalog["documents"] = existing_documents
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    report["mode"] = "applied"
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print_summary(report)
    print("Applied catalog onboarding. Run npm.cmd test and review all Unassigned records before facility release.")
    return 0


def inspect_pdf(path: Path) -> dict:
    result = {
        "originalFile": path.name,
        "status": "ready",
        "reason": "",
        "name": "",
        "nameSource": "",
        "revisionDate": "",
        "dateSource": "not found",
        "manufacturer": "",
        "language": infer_language(path.name, ""),
        "documentType": "SDS",
        "ocrUsed": False,
        "pages": 0,
    }

    try:
        with path.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                result.update(status="review", reason="File does not have a PDF signature")
                return result
        reader = PdfReader(str(path), strict=False)
        result["pages"] = len(reader.pages)
        page_indexes = list(dict.fromkeys([0, 1, max(0, len(reader.pages) - 1)]))
        text = "\n".join((reader.pages[index].extract_text() or "") for index in page_indexes)
    except Exception as error:  # noqa: BLE001 - try OCR before filename fallback
        text = extract_text_with_ocr(path)
        if text:
            result["ocrUsed"] = True
        else:
            fallback_name = clean_filename_name(path.stem)
            if not fallback_name:
                result.update(status="review", reason=f"PDF could not be read: {type(error).__name__}")
                return result
            result.update(
                name=fallback_name,
                nameSource="filename",
                documentType="Unverified",
                reason=f"PDF text could not be read: {type(error).__name__}",
            )
            return result

    if len(normalize_space(text)) < 100:
        ocr_text = extract_text_with_ocr(path)
        if ocr_text:
            text = ocr_text
            result["ocrUsed"] = True

    result["language"] = infer_language(path.name, text)
    normalized_text = normalize_space(text).casefold()
    filename_lower = path.name.casefold()
    is_sds = any(marker in normalized_text for marker in SDS_MARKERS) or re.search(r"(^|[^a-z])(sds|msds)([^a-z]|$)", filename_lower)
    appears_tds_only = "tds" in filename_lower and not any(marker in normalized_text for marker in SDS_MARKERS)
    if appears_tds_only:
        result["documentType"] = "TDS"
    elif not is_sds:
        result["documentType"] = "Unverified"
        result["reason"] = "Document was not confidently identified as an SDS"

    name, source = extract_name(text, path.stem)
    if not name:
        result.update(status="review", reason="Product name could not be determined")
        return result

    revision, date_source = extract_revision_date(text)
    manufacturer = extract_manufacturer(text)
    result.update(
        name=name,
        nameSource=source,
        revisionDate=revision,
        dateSource=date_source,
        manufacturer=manufacturer,
    )
    return result


def extract_name(text: str, filename_stem: str) -> tuple[str, str]:
    for pattern in NAME_PATTERNS:
        for match in pattern.finditer(text):
            candidate = clean_display_name(match.group(1))
            if acceptable_name(candidate):
                return candidate, "pdf text"
    candidate = clean_filename_name(filename_stem)
    return (candidate, "filename") if acceptable_name(candidate) else ("", "")


def extract_text_with_ocr(path: Path) -> str:
    """OCR image-only first pages when optional OCR dependencies are installed."""
    if pypdfium2 is None or pytesseract is None:
        return ""
    try:
        document = pypdfium2.PdfDocument(str(path))
        texts = []
        for page_index in range(min(2, len(document))):
            image = document[page_index].render(scale=2.2).to_pil()
            candidates = []
            for angle in (0, 90, 270):
                rotated = image if angle == 0 else image.rotate(angle, expand=True)
                candidate = pytesseract.image_to_string(rotated, config="--psm 6")
                score = sum(character.isalnum() for character in candidate)
                score += 500 if any(marker in candidate.casefold() for marker in SDS_MARKERS) else 0
                score += 300 if re.search(r"(?i)(product|trade)\s+name\s*:", candidate) else 0
                candidates.append((score, candidate))
            texts.append(max(candidates, key=lambda item: item[0])[1])
        return "\n".join(texts)
    except Exception:  # OCR is an optional fallback; retain filename-based review behavior.
        return ""


def extract_revision_date(text: str) -> tuple[str, str]:
    for match in DATE_PATTERN.finditer(text):
        raw = normalize_space(match.group(1)).strip(" .;,")
        parsed = parse_date_safely(raw)
        if parsed:
            return parsed, raw
    return "", "not found"


def parse_date_safely(raw: str) -> str:
    normalized = raw.replace(".", "/") if re.fullmatch(r"\d{1,4}\.\d{1,2}\.\d{1,4}", raw) else raw
    numeric = re.fullmatch(r"(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})", normalized)
    if numeric:
        first, second, third = (int(value) for value in numeric.groups())
        if first >= 1900:
            year, month, day = first, second, third
        elif third >= 1900:
            year = third
            if first > 12:
                day, month = first, second
            elif second > 12:
                month, day = first, second
            else:
                return ""  # Do not guess ambiguous numeric dates.
        else:
            return ""
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return ""
    try:
        parsed = date_parser.parse(raw, fuzzy=False, dayfirst=True)
        return parsed.date().isoformat()
    except (ValueError, OverflowError):
        return ""


def extract_manufacturer(text: str) -> str:
    match = MANUFACTURER_PATTERN.search(text)
    if not match:
        return ""
    candidate = clean_display_name(match.group(1))
    if not candidate or any(token in candidate.casefold() for token in ("not available", "not applicable", "n/a")):
        return ""
    return candidate[:140]


def infer_language(filename: str, text: str) -> str:
    name = filename.casefold()
    if re.search(r"(?:^|[_.\s-])(ms|my|bm|malay)(?:[_.\s-]|$)", name):
        return "Malay"
    if re.search(r"(?:^|[_.\s-])(en|eng|english)(?:[_.\s-]|$)", name):
        return "English"
    lowered = text.casefold()
    if any(marker in lowered for marker in ("helaian data keselamatan", "nama produk", "tarikh semakan")):
        return "Malay"
    return "English"


def clean_filename_name(stem: str) -> str:
    value = stem.replace("_", " ")
    value = re.sub(r"^\s*\d+\s*[-.)]\s*", "", value)
    value = re.sub(r"\s*\(\d+\)\s*$", "", value)
    value = re.sub(r"(?i)^\s*(?:sds|msds|csds)\s*[-_ ]*", "", value)
    value = re.sub(r"(?i)\s*[-_ ]*(?:sds|msds|safety data sheet|material safety data sheet)\s*$", "", value)
    value = re.sub(r"(?i)\s+(?:en|eng|english|ms|my|bm|malay)(?:\s+rev(?:ision)?\s*[\w.\-]+)?\s*$", "", value)
    value = re.sub(r"(?i)\s+rev(?:ision)?\s*[\w.\-]+\s*$", "", value)
    value = re.sub(r"(?i)\s+tcm\d+[\w-]*\s*$", "", value)
    return clean_display_name(value)


def clean_display_name(value: str) -> str:
    value = value.replace("\x00", " ")
    value = normalize_space(value).strip(" -_:;,.")
    value = re.sub(r"(?i)^\s*(?:product name|trade name|material name)\s*", "", value)
    value = re.sub(r"(?i)^\s*[ivx]+\)\s*", "", value)
    value = re.split(
        r"(?i)\s+(?:reference\s+no\.?|other\s+names?\s*/?\s*synonyms?|issue\s+date|tarikh\s+(?:keluaran|semakan|diterbitkan))\s*[:\-]?",
        value,
        maxsplit=1,
    )[0]
    return value[:160]


def acceptable_name(value: str) -> bool:
    lowered = value.casefold()
    if len(value) < 2 or len(value) > 160:
        return False
    rejected = (
        "not available",
        "not applicable",
        "safety data sheet",
        "material safety data sheet",
        "organic mixture",
        "chemical mixture",
        "code",
    )
    return (
        lowered not in rejected
        and "%" not in value
        and not lowered.startswith(("address", "telephone", "recommended use"))
    )


def normalize_space(value: str) -> str:
    return re.sub(r"[ \t\r\f\v]+", " ", value).strip()


def slugify(value: str) -> str:
    value = value.casefold()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")[:100].strip("-")


def unique_token(candidate: str, used_casefold: set[str]) -> str:
    candidate = slugify(candidate) or "unnamed-sds"
    if candidate.casefold() not in used_casefold:
        return candidate
    suffix = 2
    while f"{candidate}-{suffix}".casefold() in used_casefold:
        suffix += 1
    return f"{candidate}-{suffix}"


def unique_filename(candidate: str, used_casefold: set[str]) -> str:
    candidate = candidate.casefold()
    candidate = re.sub(r"[^a-z0-9.-]+", "-", candidate).strip("-.")
    if not candidate.endswith(".pdf"):
        candidate += ".pdf"
    if PDF_NAME_RE.fullmatch(candidate) and candidate.casefold() not in used_casefold:
        return candidate
    stem = candidate[:-4]
    suffix = 2
    while f"{stem}-{suffix}.pdf".casefold() in used_casefold:
        suffix += 1
    return f"{stem}-{suffix}.pdf"


def choose_canonical(paths: list[Path]) -> Path:
    def score(path: Path) -> tuple[int, int, str]:
        copy_penalty = 1 if re.search(r"\(\d+\)|_2\b|\bcopy\b", path.stem, re.IGNORECASE) else 0
        return copy_penalty, len(path.name), path.name.casefold()

    return sorted(paths, key=score)[0]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def move_preserving(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        shutil.move(str(source), str(destination))
        return
    suffix = 2
    while True:
        candidate = destination.with_name(f"{destination.stem}-{suffix}{destination.suffix}")
        if not candidate.exists():
            shutil.move(str(source), str(candidate))
            return
        suffix += 1


def print_summary(report: dict) -> None:
    summary = report["summary"]
    print(
        "PDF onboarding summary: "
        f"{summary['rootPdfFiles']} files, "
        f"{summary['uniquePdfContent']} unique, "
        f"{summary['proposedRegistrations']} proposed, "
        f"{summary['exactDuplicateCopies']} duplicate copies, "
        f"{summary['needsManualReview']} requiring manual review."
    )


if __name__ == "__main__":
    raise SystemExit(main())
