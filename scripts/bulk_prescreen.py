"""Rule-first bulk SDS pre-screening for GitHub Actions and local EHS review.

The scanner extends the existing onboarding/enrichment extractors. It never
publishes, approves, renames, moves, deletes, or overwrites an SDS. Full PDF text
stays in memory only; report output contains short evidence snippets.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import enrich_metadata as enrich  # noqa: E402
import onboard_pdfs as onboard  # noqa: E402

try:
    from pypdf import PdfReader
except ImportError:
    print("Missing scanner dependencies. Run: python -m pip install -r scripts/requirements-admin.txt", file=sys.stderr)
    raise SystemExit(2)


ROOT = Path(__file__).resolve().parents[1]
SCANNER_VERSION = "1.0"
REPORT_SCHEMA_VERSION = 1
DEFAULT_OUTPUTS = {
    "prescreen": "bulk-prescreen-report.json",
    "queue": "bulk-review-queue.json",
    "ai": "bulk-ai-verification-log.json",
    "summary": "bulk-scan-summary.json",
}

SDS_MARKERS = tuple(onboard.SDS_MARKERS)
DOCUMENT_HINTS = {
    "TDS": ("technical data sheet", "product data sheet", "tds"),
    "Manual": ("instruction manual", "user manual", "operating manual"),
    "Certificate": ("certificate of analysis", "certificate of conformity", "test certificate"),
}
PRODUCT_LABELS = ("product name", "product identifier", "material name", "nama produk")
TRADE_LABELS = ("trade name", "commercial product name", "nama dagangan")
MANUFACTURER_LABELS = ("manufacturer", "manufactured by", "pengilang", "dikilangkan oleh")
SUPPLIER_LABELS = ("supplier", "supplier name", "pembekal")
PRODUCT_CODE_LABELS = ("product code", "product number", "product no", "material code", "kod produk")
USE_LABELS = ("recommended use", "identified use", "product use", "kegunaan yang disarankan")

DATE_LABELS = {
    "revision_date": (
        "revision date", "revised date", "date of revision", "date revised", "last revised",
        "tarikh semakan", "tarikh disemak", "tarikh pindaan",
    ),
    "issue_date": (
        "issue date", "issued date", "date of issue", "tarikh dikeluarkan", "tarikh keluaran", "tarikh terbitan",
    ),
}

SECTION_TITLES = {
    1: ("identification", "pengenalan"),
    2: ("hazard identification", "hazards identification", "pengenalan bahaya"),
    3: ("composition", "information on ingredients", "komposisi", "ramuan"),
    4: ("first aid", "first-aid", "pertolongan cemas"),
    5: ("fire fighting", "fire-fighting", "firefighting", "pemadaman kebakaran"),
    6: ("accidental release", "pelepasan tidak sengaja"),
    7: ("handling and storage", "pengendalian dan penyimpanan"),
    8: ("exposure controls", "personal protection", "kawalan pendedahan", "perlindungan diri"),
    9: ("physical and chemical properties", "physical & chemical properties", "sifat fizikal dan kimia"),
    10: ("stability and reactivity", "kestabilan dan kereaktifan"),
    11: ("toxicological", "toksikologi"),
    12: ("ecological", "ekologi"),
    13: ("disposal", "pelupusan"),
    14: ("transport", "pengangkutan"),
    15: ("regulatory", "pengawalseliaan", "pengawalan"),
    16: ("other information", "maklumat lain", "maklumat tambahan"),
}
KEY_SECTIONS = (1, 2, 4, 5, 7, 8, 13)

HIGH_H_CODES = {
    "H300", "H301", "H310", "H311", "H314", "H317", "H330", "H331", "H334",
    "H340", "H350", "H360", "H370", "H372",
}
MEDIUM_H_CODES = {"H302", "H312", "H315", "H319", "H332", "H335", "H336"}
HIGH_RISK_TERMS = (
    "danger", "toxic", "fatal", "corrosive", "flammable", "highly flammable", "oxidizer", "oxidiser",
    "explosive", "carcinogenic", "carcinogen", "mutagenic", "mutagen", "reproductive toxicity",
    "respiratory sensitizer", "respiratory sensitiser", "acute toxicity", "compressed gas",
)
HAZARD_KEYWORDS = HIGH_RISK_TERMS + (
    "warning", "harmful", "irritant", "irritation", "environmental hazard", "aquatic toxicity",
)

DECISION_LABELS = {
    "full_review_required": "Full Review Required",
    "ocr_review_required": "OCR Review Required",
    "quick_check_required": "Quick Check Required",
    "conflict_duplicate": "Conflict / Duplicate",
    "not_sds_or_replace_file": "Not SDS / Replace File",
    "auto_prescreen_pass": "Prescreen Passed",
    "no_review_required_existing_unchanged": "Existing Unchanged",
    "error_needs_review": "Error - Needs Review",
}
ACTION_REQUIRED = {
    "full_review_required", "ocr_review_required", "quick_check_required", "conflict_duplicate",
    "not_sds_or_replace_file", "error_needs_review",
}
DECISION_SEVERITY = {
    "no_review_required_existing_unchanged": 0,
    "auto_prescreen_pass": 1,
    "quick_check_required": 2,
    "ocr_review_required": 3,
    "conflict_duplicate": 4,
    "full_review_required": 4,
    "not_sds_or_replace_file": 4,
    "error_needs_review": 5,
}
AI_ALLOWED_DECISIONS = {
    "auto_prescreen_pass", "quick_check_required", "full_review_required",
    "ocr_review_required", "not_sds_or_replace_file",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def comparison_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalize(value).casefold())


def unique(values: list[str]) -> list[str]:
    result = []
    seen = set()
    for value in values:
        cleaned = normalize(value).strip(" -_:;,.")
        if cleaned and cleaned.casefold() not in seen:
            seen.add(cleaned.casefold())
            result.append(cleaned)
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def label_values(text: str, labels: tuple[str, ...], limit: int = 160) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    for label in sorted(labels, key=len, reverse=True):
        escaped = re.escape(label)
        patterns = (
            re.compile(rf"(?im)^\s*{escaped}\s*(?:and\s+code)?\s*[:#\-]\s*([^\n]{{2,{limit}}})"),
            re.compile(rf"(?im)^\s*{escaped}\s*$\s*^\s*([^\n]{{2,{limit}}})"),
        )
        for pattern in patterns:
            for match in pattern.finditer(text):
                candidate = onboard.clean_display_name(match.group(1))
                if onboard.acceptable_name(candidate):
                    hits.append((candidate, normalize(match.group(0))[:220]))
    deduped: list[tuple[str, str]] = []
    seen = set()
    for value, evidence in hits:
        if value.casefold() not in seen:
            seen.add(value.casefold())
            deduped.append((value, evidence))
    return deduped


def plain_label_value(text: str, labels: tuple[str, ...], limit: int = 180) -> tuple[str, str]:
    for label in sorted(labels, key=len, reverse=True):
        escaped = re.escape(label)
        match = re.search(rf"(?im)^\s*{escaped}\s*(?:name)?\s*[:#\-]\s*([^\n]{{2,{limit}}})", text)
        if not match:
            continue
        candidate = onboard.clean_display_name(match.group(1))
        candidate = re.split(r"(?i)\b(address|telephone|phone|fax|email|emergency)\b", candidate)[0].strip(" -:;,")
        if candidate and not re.search(r"(?i)\b(not available|not applicable|n/?a)\b", candidate):
            return candidate[:limit], normalize(match.group(0))[:240]
    return "", ""


def detect_sections(text: str) -> tuple[list[int], list[int], int]:
    source = str(text or "")
    found = []
    for number, titles in SECTION_TITLES.items():
        matched = False
        for title in titles:
            pattern = re.compile(
                rf"(?is)(?:section\s*)?0?{number}\s*(?:[.\-:\u2013\u2014]|\s)"
                rf".{{0,110}}?{re.escape(title)}"
            )
            if pattern.search(source):
                matched = True
                break
        if matched:
            found.append(number)
    missing = [number for number in range(1, 17) if number not in found]
    return found, missing, round(len(found) / 16 * 100)


def section_snippet(text: str, number: int, max_chars: int) -> str:
    titles = SECTION_TITLES[number]
    for title in titles:
        match = re.search(
            rf"(?is)(?:section\s*)?0?{number}\s*(?:[.\-:\u2013\u2014]|\s).{{0,100}}?{re.escape(title)}",
            text,
        )
        if match:
            end = min(len(text), match.start() + max_chars)
            if number < 16:
                next_heading = re.search(
                    rf"(?im)^\s*(?:section\s*)?0?{number + 1}\s*(?:[.\-:\u2013\u2014]|\s)",
                    text[match.end():],
                )
                if next_heading:
                    end = min(end, match.end() + next_heading.start())
            return normalize(text[match.start():end])[:max_chars]
    return ""


def detect_date(text: str, field: str) -> dict[str, Any]:
    labels = DATE_LABELS[field]
    pattern = re.compile(
        r"(?i)(?<![A-Za-z])(?P<label>" + "|".join(re.escape(label) for label in labels)
        + r")\s*[:#.\-]?\s*" + enrich.DATE_VALUE
    )
    candidates = []
    for match in pattern.finditer(text):
        raw = match.group("d").strip(" .,;")
        parsed, ambiguous = enrich.parse_date(raw)
        if parsed:
            candidates.append({
                "value": parsed,
                "raw": raw,
                "label": normalize(match.group("label")),
                "ambiguous": ambiguous,
                "evidence": normalize(match.group(0))[:180],
            })
    if not candidates:
        return {"value": "", "raw": "", "label": "", "ambiguous": False, "evidence": ""}
    candidates.sort(key=lambda item: item["value"], reverse=True)
    result = candidates[0]
    result["conflict"] = len({item["value"] for item in candidates}) > 1
    return result


def classify_document(text: str, filename: str, sections_found: list[int]) -> tuple[str, list[str]]:
    normalized = normalize(text).casefold()
    name = filename.casefold()
    if any(marker in normalized for marker in SDS_MARKERS) or (1 in sections_found and 2 in sections_found):
        return "SDS", []
    for document_type, hints in DOCUMENT_HINTS.items():
        if any(hint in normalized or re.search(rf"(?:^|[^a-z]){re.escape(hint)}(?:[^a-z]|$)", name) for hint in hints):
            return document_type, [f"Document appears to be {document_type}, not an SDS"]
    return "Unknown", ["Document could not be confidently classified as an SDS"]


def extract_text(path: Path, native_pages: int, ocr_pages: int) -> dict[str, Any]:
    result = {
        "text": "", "native_text_length": 0, "ocr_used": False, "ocr_state": "not_needed",
        "extraction_method": "native_pdf_text", "pages": 0, "pages_read": 0, "error": "",
    }
    try:
        with path.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise ValueError("File does not have a PDF signature")
        reader = PdfReader(str(path), strict=False)
        result["pages"] = len(reader.pages)
        page_count = min(len(reader.pages), max(1, native_pages))
        parts = []
        for index in range(page_count):
            try:
                parts.append(reader.pages[index].extract_text() or "")
            except Exception:
                parts.append("")
        text = "\n\n".join(parts)
        result["pages_read"] = page_count
        result["native_text_length"] = len(normalize(text))
    except Exception as error:  # noqa: BLE001 - file-level failure is reported and scanning continues
        text = ""
        result["error"] = f"{type(error).__name__}: {error}"[:300]

    if len(normalize(text)) >= 300:
        result["text"] = text
        return result

    ocr_text, ocr_state = extract_ocr_text(path, ocr_pages)
    result["ocr_state"] = ocr_state
    if ocr_text:
        result["text"] = ocr_text
        result["ocr_used"] = True
        result["extraction_method"] = "tesseract_ocr"
        result["error"] = ""
    else:
        result["text"] = text
        result["extraction_method"] = "native_pdf_text_weak" if text else "unreadable"
    return result


def extract_ocr_text(path: Path, max_pages: int) -> tuple[str, str]:
    if onboard.pypdfium2 is None or onboard.pytesseract is None:
        return "", "not_configured"
    try:
        document = onboard.pypdfium2.PdfDocument(str(path))
        texts = []
        for page_index in range(min(max(1, max_pages), len(document))):
            image = document[page_index].render(scale=2.0).to_pil()
            candidates = []
            for psm in (6, 3):
                candidate = onboard.pytesseract.image_to_string(image, config=f"--psm {psm}")
                score = sum(character.isalnum() for character in candidate)
                score += 600 if any(marker in candidate.casefold() for marker in SDS_MARKERS) else 0
                candidates.append((score, candidate))
            texts.append(max(candidates, key=lambda item: item[0])[1])
        text = "\n\n".join(texts)
        return (text, "completed") if normalize(text) else ("", "weak_or_empty")
    except Exception as error:  # noqa: BLE001 - OCR is a per-file fallback
        return "", f"error:{type(error).__name__}"


def analyze_text(text: str, filename: str, *, ocr_used: bool = False, extraction_error: str = "", evidence_max: int = 3000) -> dict[str, Any]:
    sections_found, missing_sections, section_confidence = detect_sections(text)
    product_hits = label_values(text, PRODUCT_LABELS)
    trade_hits = label_values(text, TRADE_LABELS)
    product_name = product_hits[0][0] if product_hits else ""
    trade_name = trade_hits[0][0] if trade_hits else ""
    manufacturer, manufacturer_evidence = plain_label_value(text, MANUFACTURER_LABELS)
    supplier, supplier_evidence = plain_label_value(text, SUPPLIER_LABELS)
    product_code, product_code_evidence = plain_label_value(text, PRODUCT_CODE_LABELS, 100)
    recommended_use, use_evidence = plain_label_value(text, USE_LABELS, 500)
    revision = detect_date(text, "revision_date")
    issue = detect_date(text, "issue_date")
    signal_match = re.search(r"(?i)(?:signal\s+word\s*[:\-]?\s*)?\b(DANGER|WARNING|BAHAYA|AMARAN)\b", text)
    signal_word = signal_match.group(1).upper() if signal_match else ""
    h_codes = sorted(set(re.findall(r"\bH\d{3}(?:\+H\d{3})?\b", text, flags=re.IGNORECASE)))
    p_codes = sorted(set(re.findall(r"\bP\d{3}(?:\+P\d{3})*\b", text, flags=re.IGNORECASE)))
    hazard_scope = section_snippet(text, 2, 2400) or text[:2400]
    hazard_lowered = hazard_scope.casefold()
    hazard_keywords = [term for term in HAZARD_KEYWORDS if term in hazard_lowered]
    document_type, type_reasons = classify_document(text, filename, sections_found)
    fallback_name = onboard.clean_filename_name(Path(filename).stem)
    id_candidate = onboard.slugify(product_name or trade_name or fallback_name)
    multiple_names = len(product_hits) > 1
    date_ambiguous = bool(revision.get("ambiguous") or issue.get("ambiguous"))
    date_conflict = bool(revision.get("conflict") or issue.get("conflict"))

    evidence_per_section = max(220, min(800, evidence_max // 4))
    evidence = {
        "section_1": section_snippet(text, 1, evidence_per_section) or (product_hits[0][1] if product_hits else trade_hits[0][1] if trade_hits else ""),
        "section_2": section_snippet(text, 2, evidence_per_section),
        "section_8": section_snippet(text, 8, evidence_per_section),
        "date": revision.get("evidence") or issue.get("evidence") or "",
    }
    evidence = {key: value[:evidence_per_section] for key, value in evidence.items() if value}

    record = {
        "id_candidate": id_candidate,
        "product_name": product_name,
        "trade_name": trade_name,
        "manufacturer": manufacturer,
        "supplier": supplier,
        "product_code": product_code,
        "recommended_use": recommended_use,
        "language": onboard.infer_language(filename, text),
        "revision_date": revision.get("value", ""),
        "issue_date": issue.get("value", ""),
        "date_ambiguous": date_ambiguous,
        "date_conflict": date_conflict,
        "date_source": revision.get("evidence") or issue.get("evidence") or "",
        "signal_word": signal_word,
        "h_codes": h_codes,
        "p_codes": p_codes,
        "hazard_keywords": hazard_keywords,
        "sections_found": sections_found,
        "missing_sections": missing_sections,
        "section_detection_confidence": section_confidence,
        "key_sections": {str(number): number in sections_found for number in KEY_SECTIONS},
        "document_type": document_type,
        "multiple_possible_product_names": multiple_names,
        "product_name_source": "labelled_section_1" if product_hits else "missing",
        "trade_name_source": "labelled_section_1" if trade_hits else "missing",
        "manufacturer_source": "labelled" if manufacturer else "missing",
        "supplier_source": "labelled" if supplier else "missing",
        "field_evidence": {
            "product_name": product_hits[0][1] if product_hits else "",
            "trade_name": trade_hits[0][1] if trade_hits else "",
            "manufacturer": manufacturer_evidence,
            "supplier": supplier_evidence,
            "product_code": product_code_evidence,
            "recommended_use": use_evidence,
        },
        "evidence_snippets": evidence,
        "ocr_used": bool(ocr_used),
        "extraction_error": extraction_error,
        "rule_issues": list(type_reasons),
    }
    record["confidence_score"] = calculate_confidence(record, len(normalize(text)))
    record["risk_level"] = detect_risk(record)
    record["review_decision"], record["review_reasons"] = decide_review(record)
    return record


def calculate_confidence(record: dict[str, Any], text_length: int) -> int:
    if record.get("extraction_error") and text_length == 0:
        return 0
    score = 0
    if record.get("product_name") or record.get("trade_name"):
        score += 20
    if record.get("manufacturer") or record.get("supplier"):
        score += 15
    sections = set(record.get("sections_found", []))
    score += 10 if 1 in sections else 0
    score += 15 if 2 in sections else 0
    score += 10 if 4 in sections else 0
    score += 10 if 5 in sections else 0
    score += 10 if 7 in sections else 0
    score += 15 if 8 in sections else 0
    score += 10 if record.get("signal_word") or record.get("h_codes") else 0
    score += 5 if record.get("revision_date") or record.get("issue_date") else 0
    score = min(100, score)
    if record.get("ocr_used"):
        score -= 15
    if record.get("ocr_used") and text_length < 300:
        score -= 20
    if not record.get("product_name") and not record.get("trade_name"):
        score -= 15
    if record.get("multiple_possible_product_names"):
        score -= 15
    if 2 not in sections:
        score -= 25
    if 8 not in sections:
        score -= 20
    if record.get("date_ambiguous"):
        score -= 10
    if record.get("document_type") != "SDS":
        score -= 30
    return max(0, min(100, score))


def detect_risk(record: dict[str, Any]) -> str:
    codes = {code.upper() for code in record.get("h_codes", [])}
    terms = {term.casefold() for term in record.get("hazard_keywords", [])}
    if codes & HIGH_H_CODES or terms & {term.casefold() for term in HIGH_RISK_TERMS} or record.get("signal_word") in {"DANGER", "BAHAYA"}:
        return "high"
    if 2 not in set(record.get("sections_found", [])):
        return "unknown"
    if codes & MEDIUM_H_CODES or record.get("signal_word") in {"WARNING", "AMARAN"}:
        return "medium"
    return "low"


def decide_review(record: dict[str, Any]) -> tuple[str, list[str]]:
    reasons = list(record.get("rule_issues", []))
    sections = set(record.get("sections_found", []))
    confidence = int(record.get("confidence_score", 0))

    if record.get("scan_error") or (record.get("extraction_error") and not record.get("product_name") and not record.get("trade_name")):
        reasons.append("PDF extraction failed or returned no usable identity")
        return "error_needs_review", unique(reasons)
    if record.get("document_type") != "SDS":
        return "not_sds_or_replace_file", unique(reasons or ["Document is not confidently classified as an SDS"])
    if record.get("existing_approved_unchanged") and not record.get("conflicts"):
        return "no_review_required_existing_unchanged", ["Approved catalog PDF hash and metadata are unchanged"]
    if record.get("duplicate_conflict"):
        reasons.append("Duplicate or product-name collision requires a controlling-record decision")
        return "conflict_duplicate", unique(reasons)
    if record.get("risk_level") == "high":
        reasons.append("High-risk hazard indicator detected")
    if not record.get("product_name") and not record.get("trade_name"):
        reasons.append("Product/trade name is missing")
    if not record.get("manufacturer") and not record.get("supplier"):
        reasons.append("Manufacturer/supplier is missing")
    if 2 not in sections:
        reasons.append("Critical Section 2 Hazard Identification is missing")
    if 8 not in sections:
        reasons.append("Critical Section 8 Exposure Controls/PPE is missing")
    if record.get("multiple_possible_product_names"):
        reasons.append("Multiple possible product names detected")
    if record.get("revision_changed"):
        reasons.append("Revision date changed from the approved catalog record")
    if record.get("conflicts") and not record.get("duplicate_conflict"):
        reasons.append("Metadata conflict with the approved catalog or verification evidence")
    if record.get("date_conflict"):
        reasons.append("Conflicting SDS dates detected")
    if record.get("date_ambiguous"):
        reasons.append("Ambiguous numeric date requires confirmation")
    severe = reasons and any(
        phrase in reason for reason in reasons for phrase in (
            "High-risk", "Product/trade", "Manufacturer/supplier", "Section 2", "Section 8",
            "Multiple possible", "Revision date changed", "Metadata conflict", "Conflicting",
        )
    )
    if severe:
        return "full_review_required", unique(reasons)
    if record.get("ocr_used"):
        if confidence < 70:
            reasons.append(f"OCR rule confidence is low ({confidence})")
        reasons.append("Tesseract OCR was used; verify the original PDF visually")
        return "ocr_review_required", unique(reasons)
    if record.get("date_ambiguous"):
        return "quick_check_required", unique(reasons or ["Ambiguous numeric date requires confirmation"])
    if confidence < 70:
        reasons.append(f"Rule confidence is below 70 ({confidence})")
        return "full_review_required", unique(reasons)
    if 70 <= confidence <= 84:
        reasons.append(f"Moderate rule confidence ({confidence})")
        return "quick_check_required", unique(reasons)
    if (
        confidence >= 85 and (record.get("product_name") or record.get("trade_name"))
        and (record.get("manufacturer") or record.get("supplier"))
        and 2 in sections and 8 in sections and record.get("risk_level") in {"low", "medium"}
    ):
        return "auto_prescreen_pass", ["Strong native extraction with critical identity and safety sections present"]
    return "quick_check_required", unique(reasons or ["A short EHS confirmation is required"])


def should_use_ai(record: dict[str, Any], mode: str) -> bool:
    if mode == "off" or record.get("cache_reused") or record.get("review_decision") in {"no_review_required_existing_unchanged", "error_needs_review"}:
        return False
    if mode == "all":
        return True
    confidence = int(record.get("confidence_score", 0))
    sections = set(record.get("sections_found", []))
    clear_high_confidence = (
        confidence >= 85 and not record.get("ocr_used") and (record.get("product_name") or record.get("trade_name"))
        and (record.get("manufacturer") or record.get("supplier")) and 2 in sections and 8 in sections
        and record.get("risk_level") in {"low", "medium"} and not record.get("conflicts")
        and not record.get("date_ambiguous") and not record.get("date_conflict")
    )
    if clear_high_confidence:
        return False
    return bool(
        50 <= confidence <= 84 or record.get("ocr_used") or not record.get("product_name")
        or not (record.get("manufacturer") or record.get("supplier")) or 2 not in sections or 8 not in sections
        or record.get("risk_level") == "high" or record.get("duplicate_conflict") or record.get("revision_changed")
        or record.get("conflicts") or record.get("date_ambiguous") or record.get("date_conflict") or record.get("document_type") == "Unknown"
    )


class GeminiVerifier:
    def __init__(self, api_key: str, model: str, max_calls: int, timeout_seconds: int = 25):
        self.api_key = api_key.strip()
        self.model = model
        self.max_calls = max(0, max_calls)
        self.timeout_seconds = timeout_seconds
        self.calls = 0
        self.quota_exhausted = False

    def verify(self, record: dict[str, Any]) -> dict[str, Any]:
        if not self.api_key:
            return {"status": "not_configured", "used": False, "result": None, "reason": "GEMINI_API_KEY is not configured"}
        if self.quota_exhausted:
            return {"status": "quota_exceeded", "used": False, "result": None, "reason": "Earlier Gemini call reached quota"}
        if self.calls >= self.max_calls:
            return {"status": "skipped_limit", "used": False, "result": None, "reason": f"AI_MAX_CALLS={self.max_calls} reached"}
        self.calls += 1
        compact = {
            "file_name": record.get("file_name"),
            "extracted_fields": {
                key: record.get(key) for key in (
                    "product_name", "trade_name", "manufacturer", "supplier", "revision_date", "issue_date",
                    "signal_word", "h_codes", "p_codes", "document_type", "sections_found",
                )
            },
            "confidence_score": record.get("confidence_score"),
            "risk_level": record.get("risk_level"),
            "detected_issues": record.get("review_reasons", []),
            "evidence_snippets": record.get("evidence_snippets", {}),
        }
        instruction = (
            "Verify whether the extracted SDS fields are supported by the supplied short evidence. "
            "Do not invent missing data. Do not summarize the SDS. Do not approve. Return JSON only with keys: "
            "ai_verification_used, verification_status (passed|warning|failed), supported_fields, unsupported_fields, "
            "missing_critical_fields, conflicts, recommended_review_decision "
            "(auto_prescreen_pass|quick_check_required|full_review_required|ocr_review_required|not_sds_or_replace_file), reason."
        )
        payload = {
            "system_instruction": {"parts": [{"text": instruction}]},
            "contents": [{"role": "user", "parts": [{"text": json.dumps(compact, ensure_ascii=True)}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 700, "responseMimeType": "application/json"},
        }
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "x-goog-api-key": self.api_key},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - fixed Google API host
                response_payload = json.loads(response.read().decode("utf-8"))
            output = "".join(
                part.get("text", "")
                for part in response_payload.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            ).strip()
            output = re.sub(r"^```(?:json)?\s*|\s*```$", "", output, flags=re.IGNORECASE)
            result = json.loads(output)
            validated = validate_ai_result(result)
            return {"status": "verified", "used": True, "result": validated, "reason": ""}
        except urllib.error.HTTPError as error:
            if error.code == 429:
                self.quota_exhausted = True
                return {"status": "quota_exceeded", "used": False, "result": None, "reason": "Gemini quota exceeded"}
            return {"status": "error", "used": False, "result": None, "reason": f"Gemini HTTP {error.code}"}
        except (TimeoutError, socket.timeout):
            return {"status": "timeout", "used": False, "result": None, "reason": "Gemini verification timed out"}
        except Exception as error:  # noqa: BLE001 - AI errors must never fail the scan
            return {"status": "error", "used": False, "result": None, "reason": f"{type(error).__name__}: {error}"[:240]}


def validate_ai_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("AI response is not an object")
    status = value.get("verification_status")
    decision = value.get("recommended_review_decision")
    if status not in {"passed", "warning", "failed"} or decision not in AI_ALLOWED_DECISIONS:
        raise ValueError("AI response contains unsupported status/decision")
    return {
        "ai_verification_used": True,
        "verification_status": status,
        "supported_fields": string_list(value.get("supported_fields")),
        "unsupported_fields": string_list(value.get("unsupported_fields")),
        "missing_critical_fields": string_list(value.get("missing_critical_fields")),
        "conflicts": string_list(value.get("conflicts")),
        "recommended_review_decision": decision,
        "reason": normalize(value.get("reason", ""))[:500],
    }


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [normalize(item)[:300] for item in value if normalize(item)][:50]


def apply_ai_verification(record: dict[str, Any], ai: dict[str, Any]) -> None:
    record["ai_status"] = ai["status"]
    record["ai_verification_used"] = bool(ai.get("used"))
    record["ai_verification"] = ai.get("result")
    if ai.get("reason"):
        record.setdefault("review_reasons", []).append(ai["reason"])
    result = ai.get("result")
    if not result:
        return
    conflicts = result.get("conflicts", [])
    if conflicts or result.get("verification_status") == "failed":
        record["conflicts"] = unique(record.get("conflicts", []) + conflicts + result.get("unsupported_fields", []))
        record["review_decision"] = "full_review_required"
        record["review_reasons"] = unique(record.get("review_reasons", []) + ["AI verification found conflicting or unsupported evidence"])
        return
    recommended = result.get("recommended_review_decision")
    current = record.get("review_decision")
    if DECISION_SEVERITY.get(recommended, 0) > DECISION_SEVERITY.get(current, 0):
        record["review_decision"] = recommended
        record["review_reasons"] = unique(record.get("review_reasons", []) + [result.get("reason") or "AI recommended stricter review"])


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback


def load_cache(path: Path) -> dict[str, Any]:
    cache = load_json(path, {})
    if cache.get("schemaVersion") != REPORT_SCHEMA_VERSION:
        return {"schemaVersion": REPORT_SCHEMA_VERSION, "scannerVersion": SCANNER_VERSION, "resultsBySha256": {}}
    return cache


def reusable_cached_record(cache: dict[str, Any], digest: str, force: bool) -> dict[str, Any] | None:
    if force or cache.get("scannerVersion") != SCANNER_VERSION:
        return None
    value = cache.get("resultsBySha256", {}).get(digest)
    return copy.deepcopy(value) if isinstance(value, dict) else None


def scan_pdf(path: Path, args: argparse.Namespace, cache: dict[str, Any]) -> dict[str, Any]:
    digest = sha256_file(path)
    cached = reusable_cached_record(cache, digest, args.force)
    if cached:
        cached.update(
            file_name=path.name, relative_path=path.relative_to(ROOT).as_posix(), file_size=path.stat().st_size,
            sha256=digest, cache_reused=True, scan_status="unchanged_cached",
            ai_previous_status=cached.get("ai_status", ""), ai_status="skipped_unchanged", ai_verification_used=False,
        )
        for field in ("duplicate_status", "duplicate_conflict", "existing_catalog_match", "existing_approved_unchanged", "revision_changed", "conflicts"):
            cached.pop(field, None)
        return cached

    extracted = extract_text(path, args.native_pages, args.ocr_pages)
    record = analyze_text(
        extracted["text"], path.name, ocr_used=extracted["ocr_used"],
        extraction_error=extracted["error"], evidence_max=args.evidence_max_chars,
    )
    record.update(
        file_name=path.name,
        relative_path=path.relative_to(ROOT).as_posix(),
        file_size=path.stat().st_size,
        sha256=digest,
        pages=extracted["pages"],
        pages_read=extracted["pages_read"],
        native_text_length=extracted["native_text_length"],
        extraction_method=extracted["extraction_method"],
        ocr_state=extracted["ocr_state"],
        cache_reused=False,
        scan_status="scanned",
        ai_status="pending",
        ai_verification_used=False,
        ai_verification=None,
        conflicts=[],
    )
    return record


def annotate_catalog_and_duplicates(records: list[dict[str, Any]], catalog: dict[str, Any], pdf_dir: Path) -> None:
    catalog_docs = catalog.get("documents", []) if isinstance(catalog, dict) else []
    by_file = {str(doc.get("file", "")).casefold(): doc for doc in catalog_docs}
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    catalog_hashes = {}
    for doc in catalog_docs:
        name = normalize(doc.get("name", "")).casefold()
        if name:
            by_name[name].append(doc)
        path = pdf_dir / str(doc.get("file", ""))
        if path.is_file():
            try:
                catalog_hashes[str(doc.get("file", "")).casefold()] = sha256_file(path)
            except OSError:
                pass

    hash_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    product_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        hash_groups[record["sha256"]].append(record)
        product_key = normalize(record.get("product_name") or record.get("trade_name")).casefold()
        if product_key:
            product_groups[product_key].append(record)

    for digest, group in hash_groups.items():
        if len(group) > 1:
            canonical = sorted(group, key=lambda item: item["file_name"].casefold())[0]
            for record in group:
                if record is not canonical:
                    record["duplicate_status"] = "exact_hash_duplicate"
                    record["duplicate_conflict"] = True
                    record["conflicts"] = unique(record.get("conflicts", []) + [f"Exact hash matches {canonical['file_name']}"])

    for product, group in product_groups.items():
        if len({record["sha256"] for record in group}) > 1:
            for record in group:
                record["duplicate_status"] = "product_name_collision"
                record["duplicate_conflict"] = True
                record["conflicts"] = unique(record.get("conflicts", []) + ["Same product identity appears with different PDF hashes"])

    for record in records:
        catalog_doc = by_file.get(record["file_name"].casefold())
        product_key = normalize(record.get("product_name") or record.get("trade_name")).casefold()
        product_matches = by_name.get(product_key, []) if product_key else []
        match = catalog_doc or (product_matches[0] if len(product_matches) == 1 else None)
        if match:
            same_hash = catalog_hashes.get(str(match.get("file", "")).casefold()) == record["sha256"]
            approved_revision = str(match.get("revisionDate") or "")
            extracted_revision = str(record.get("revision_date") or "")
            revision_changed = bool(approved_revision and extracted_revision and approved_revision != extracted_revision)
            approved_name = comparison_key(match.get("name"))
            extracted_name = comparison_key(record.get("product_name") or record.get("trade_name"))
            approved_manufacturer = comparison_key(match.get("manufacturer"))
            extracted_manufacturer = comparison_key(record.get("manufacturer") or record.get("supplier"))
            metadata_conflicts = []
            if approved_name and extracted_name and approved_name != extracted_name:
                metadata_conflicts.append("Extracted product identity differs from the approved catalog metadata")
            if approved_manufacturer and extracted_manufacturer and approved_manufacturer != extracted_manufacturer:
                metadata_conflicts.append("Extracted manufacturer/supplier differs from the approved catalog metadata")
            if revision_changed:
                metadata_conflicts.append("Extracted revision date differs from the approved catalog metadata")
            record["conflicts"] = unique(record.get("conflicts", []) + metadata_conflicts)
            record["existing_catalog_match"] = {
                "id": match.get("id"), "name": match.get("name"), "file": match.get("file"),
                "revision_date": match.get("revisionDate", ""), "same_hash": same_hash,
            }
            record["revision_changed"] = revision_changed
            record["existing_approved_unchanged"] = bool(same_hash and not record.get("duplicate_conflict") and not metadata_conflicts)
            if not same_hash and product_key:
                record["duplicate_conflict"] = True
                record["conflicts"] = unique(record.get("conflicts", []) + ["Approved product match has a different PDF hash"])
        else:
            record["existing_catalog_match"] = None
            record["existing_approved_unchanged"] = False
            record["revision_changed"] = False
        record["review_decision"], record["review_reasons"] = decide_review(record)


def build_enrichment_proposals(records: list[dict[str, Any]], catalog: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = {str(doc.get("id")): doc for doc in catalog.get("documents", [])}
    proposals = []
    for record in records:
        match = record.get("existing_catalog_match") or {}
        doc = by_id.get(str(match.get("id")))
        if not doc or record.get("confidence_score", 0) < 85 or record.get("ocr_used"):
            continue
        fill = {}
        evidence = {}
        if not doc.get("manufacturer") and record.get("manufacturer") and record.get("manufacturer_source") == "labelled":
            fill["manufacturer"] = record["manufacturer"]
            evidence["manufacturer"] = record.get("field_evidence", {}).get("manufacturer", "")
        if not doc.get("revisionDate") and record.get("revision_date") and not record.get("date_ambiguous") and not record.get("date_conflict"):
            fill["revisionDate"] = record["revision_date"]
            evidence["revisionDate"] = record.get("date_source", "")
        if not doc.get("productCode") and record.get("product_code"):
            fill["productCode"] = record["product_code"]
            evidence["productCode"] = record.get("field_evidence", {}).get("product_code", "")
        if fill:
            proposals.append({"id": doc.get("id"), "file": doc.get("file"), "fill_empty_fields_only": fill, "evidence": evidence})
    return proposals


def compact_queue_item(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: record.get(key) for key in (
            "file_name", "sha256", "product_name", "trade_name", "manufacturer", "supplier",
            "existing_catalog_match", "extraction_method", "ocr_used", "confidence_score", "risk_level",
            "review_decision", "review_reasons", "missing_sections", "conflicts", "revision_date",
            "date_source", "evidence_snippets", "ai_status", "ai_verification",
        )
    }


def build_reports(records: list[dict[str, Any]], proposals: list[dict[str, Any]], args: argparse.Namespace, verifier: GeminiVerifier) -> dict[str, dict[str, Any]]:
    decisions = Counter(record.get("review_decision") for record in records)
    ai_statuses = Counter(record.get("ai_status") for record in records)
    summary = {
        "total_pdf_files": len(records),
        "scanned": sum(not record.get("cache_reused") for record in records),
        "reused_unchanged": sum(bool(record.get("cache_reused")) for record in records),
        "ocr_processed": sum(bool(record.get("ocr_used")) for record in records),
        "ai_calls": verifier.calls,
        "ai_verified": sum(record.get("ai_status") == "verified" for record in records),
        "ai_skipped_or_unavailable": sum(record.get("ai_status") != "verified" for record in records),
        "quick_check": decisions.get("quick_check_required", 0),
        "full_review": decisions.get("full_review_required", 0) + decisions.get("conflict_duplicate", 0),
        "ocr_review": decisions.get("ocr_review_required", 0),
        "errors": decisions.get("error_needs_review", 0),
        "decisions": dict(decisions),
        "ai_statuses": dict(ai_statuses),
        "enrichment_proposals": len(proposals),
    }
    generated = utc_now()
    config = {
        "ai_verify_mode": args.ai_mode,
        "ai_max_calls": args.ai_max_calls,
        "ocr_max_pages": args.ocr_pages,
        "native_max_pages": args.native_pages,
        "evidence_max_chars": args.evidence_max_chars,
        "force_rescan": args.force,
    }
    prescreen = {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "scannerVersion": SCANNER_VERSION,
        "generatedAt": generated,
        "sourceOfTruth": "Official manufacturer SDS PDF",
        "publicationEffect": "none",
        "config": config,
        "summary": summary,
        "proposedCatalogPatches": proposals,
        "records": records,
    }
    groups = []
    for decision, label in DECISION_LABELS.items():
        items = [compact_queue_item(record) for record in records if record.get("review_decision") == decision]
        if items:
            groups.append({"decision": decision, "label": label, "actionRequired": decision in ACTION_REQUIRED, "count": len(items), "items": items})
    queue = {"schemaVersion": REPORT_SCHEMA_VERSION, "generatedAt": generated, "summary": summary, "groups": groups}
    ai_log = {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "generatedAt": generated,
        "mode": args.ai_mode,
        "maxCalls": args.ai_max_calls,
        "callsMade": verifier.calls,
        "entries": [
            {
                "file_name": record.get("file_name"), "sha256": record.get("sha256"),
                "status": record.get("ai_status"), "used": record.get("ai_verification_used", False),
                "verification": record.get("ai_verification"),
            }
            for record in records
        ],
    }
    summary_report = {"schemaVersion": REPORT_SCHEMA_VERSION, "generatedAt": generated, "config": config, "summary": summary}
    return {"prescreen": prescreen, "queue": queue, "ai": ai_log, "summary": summary_report}


def validate_report(report: dict[str, Any]) -> None:
    if report.get("schemaVersion") != REPORT_SCHEMA_VERSION or not isinstance(report.get("records"), list):
        raise ValueError("Bulk pre-screen report schema is invalid")
    forbidden = {"extracted_text", "full_text", "pdf_text", "gemini_api_key"}
    for record in report["records"]:
        if forbidden & set(record):
            raise ValueError("Report contains forbidden full-text or secret fields")
        if record.get("review_decision") not in DECISION_LABELS:
            raise ValueError(f"Unsupported review decision: {record.get('review_decision')}")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def write_github_summary(path: str, summary: dict[str, Any]) -> None:
    if not path:
        return
    decisions = summary.get("decisions", {})
    lines = [
        "## Bulk SDS pre-screen",
        "",
        f"- PDFs: {summary['total_pdf_files']}",
        f"- Scanned: {summary['scanned']}",
        f"- Reused unchanged: {summary['reused_unchanged']}",
        f"- OCR processed: {summary['ocr_processed']}",
        f"- AI calls: {summary['ai_calls']}",
        f"- Prescreen passed: {decisions.get('auto_prescreen_pass', 0)}",
        f"- Existing unchanged: {decisions.get('no_review_required_existing_unchanged', 0)}",
        f"- Quick check: {summary['quick_check']}",
        f"- Full/conflict review: {summary['full_review']}",
        f"- OCR review: {summary['ocr_review']}",
        f"- Errors: {summary['errors']}",
        "",
        "AI verification is advisory only. No SDS was approved or published by this workflow.",
    ]
    with Path(path).open("a", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rule-first bulk SDS pre-screening with optional selective Gemini verification.")
    parser.add_argument("--pdf-dir", type=Path, default=ROOT / "pdfs")
    parser.add_argument("--catalog", type=Path, default=ROOT / "data" / "sds-data.json")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--cache", type=Path, default=ROOT / "data" / ".bulk-prescreen-cache.json")
    parser.add_argument("--ai-mode", choices=("off", "selective", "all"), default=os.getenv("AI_VERIFY_MODE", "selective"))
    parser.add_argument("--ai-max-calls", type=int, default=int(os.getenv("AI_MAX_CALLS", "25")))
    parser.add_argument("--ocr-pages", type=int, default=int(os.getenv("OCR_MAX_PAGES", "3")))
    parser.add_argument("--native-pages", type=int, default=int(os.getenv("NATIVE_MAX_PAGES", "40")))
    parser.add_argument("--evidence-max-chars", type=int, default=int(os.getenv("AI_EVIDENCE_MAX_CHARS", "3000")))
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    args.pdf_dir = args.pdf_dir.resolve()
    args.catalog = args.catalog.resolve()
    args.output_dir = args.output_dir.resolve()
    args.cache = args.cache.resolve()
    catalog = load_json(args.catalog, {"schemaVersion": 1, "documents": []})
    cache = load_cache(args.cache)
    pdfs = sorted(
        (path for path in args.pdf_dir.iterdir() if path.is_file() and path.suffix.casefold() == ".pdf"),
        key=lambda path: path.name.casefold(),
    ) if args.pdf_dir.exists() else []

    records = []
    for index, path in enumerate(pdfs, start=1):
        print(f"[{index}/{len(pdfs)}] {path.name}")
        try:
            records.append(scan_pdf(path, args, cache))
        except Exception as error:  # noqa: BLE001 - one bad PDF must not stop the workflow
            records.append({
                "file_name": path.name,
                "relative_path": path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name,
                "file_size": path.stat().st_size if path.exists() else 0,
                "sha256": sha256_file(path) if path.exists() else "",
                "scan_status": "error",
                "scan_error": f"{type(error).__name__}: {error}"[:300],
                "document_type": "Unknown",
                "confidence_score": 0,
                "risk_level": "unknown",
                "review_decision": "error_needs_review",
                "review_reasons": ["PDF could not be scanned"],
                "ocr_used": False,
                "ai_status": "skipped",
                "ai_verification_used": False,
                "ai_verification": None,
                "evidence_snippets": {},
                "missing_sections": list(range(1, 17)),
                "conflicts": [],
            })

    annotate_catalog_and_duplicates(records, catalog, args.pdf_dir)
    verifier = GeminiVerifier(
        os.getenv("GEMINI_API_KEY", ""), os.getenv("GEMINI_MODEL", "gemini-2.5-flash"), args.ai_max_calls,
    )
    for record in records:
        if should_use_ai(record, args.ai_mode):
            apply_ai_verification(record, verifier.verify(record))
        elif record.get("ai_status") == "pending":
            if args.ai_mode == "off":
                record["ai_status"] = "skipped_mode_off"
            elif not verifier.api_key:
                record["ai_status"] = "not_configured"
            else:
                record["ai_status"] = "skipped_rule_clear"

    proposals = build_enrichment_proposals(records, catalog)
    reports = build_reports(records, proposals, args, verifier)
    validate_report(reports["prescreen"])
    for key, filename in DEFAULT_OUTPUTS.items():
        write_json(args.output_dir / filename, reports[key])

    cache_payload = {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "scannerVersion": SCANNER_VERSION,
        "updatedAt": utc_now(),
        "resultsBySha256": {record["sha256"]: record for record in records if record.get("sha256") and not record.get("scan_error")},
    }
    write_json(args.cache, cache_payload)
    write_github_summary(os.getenv("GITHUB_STEP_SUMMARY", ""), reports["summary"]["summary"])
    summary = reports["summary"]["summary"]
    print(
        "Bulk pre-screen complete: "
        f"{summary['total_pdf_files']} PDF(s), {summary['reused_unchanged']} unchanged, "
        f"{summary['ocr_processed']} OCR, {summary['ai_calls']} AI call(s), "
        f"{summary['quick_check']} quick check, {summary['full_review']} full/conflict review, "
        f"{summary['errors']} error(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
