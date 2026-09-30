import io
import importlib.metadata
import re
import shutil
import subprocess
import unicodedata
import xml.etree.ElementTree as ET

from pypdf import PdfReader

from .files import canonical_hash, digest, private_path
from .protocol import ToolError, Verify

VERIFIER_VERSION = "1"
LAYOUT_MARGINS = {
    "rendercv-classic": (50.4, 50.4),
    "cbs-letter-times": (39.6, 31),
    "cbs-cover-letter": (54, 54),
}
CBS_PAGE_FOOTER = {"fontSize": 7, "bottom": 12, "right": 39.6, "regionWidth": 100, "regionHeight": 25}


def verifier_config_hash():
    return canonical_hash({"version": VERIFIER_VERSION, "pypdfVersion": importlib.metadata.version("pypdf"),
                           "textMinimumCharacters": 60, "pageLimits": [1, 2], "bboxEngine": "poppler-pdftotext",
                           "horizontalGlyphTolerance": 5, "verticalGlyphTolerance": 12,
                           "cbsPageFooter": CBS_PAGE_FOOTER, "rendererMargins": LAYOUT_MARGINS})


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def normalize_term(text):
    normalized = unicodedata.normalize("NFKC", text).lower()
    return " ".join("".join(" " if unicodedata.category(char) == "Pd" else char for char in normalized).split())


def contains_term(text, term):
    value, content = normalize_term(term), normalize_term(text)
    if not value:
        return False
    def word(char):
        return char in "+#" or unicodedata.category(char)[0] in ("L", "N")
    for match in re.finditer(re.escape(value), content):
        left = match.start() == 0 or not word(content[match.start() - 1])
        right = match.end() == len(content) or not word(content[match.end()])
        if left and right:
            return True
    return False


def verify(payload: Verify):
    path = private_path(payload.filename, must_exist=True)
    data = path.read_bytes()
    actual = digest(data)
    result = {"status": "passed", "artifactSha256": actual, "verifierVersion": VERIFIER_VERSION,
              "verifierConfigHash": verifier_config_hash(),
              "renderer": payload.renderer, "pageCount": None, "extractedCharacters": 0, "checks": []}

    def check(code, status, message):
        result["checks"].append({"code": code, "status": status, "message": message})
        if status == "failed" or (status == "unavailable" and result["status"] == "passed"):
            result["status"] = status

    if actual != payload.sha256:
        check("artifact_hash", "failed", "The artifact bytes do not match the reviewed hash")
        return result
    check("artifact_hash", "passed", "Exact artifact bytes verified")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            check("pdf_readable", "unavailable", "Encrypted PDFs cannot be verified")
            return result
        result["pageCount"] = len(reader.pages)
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception:
        check("pdf_readable", "unavailable", "PDF could not be read")
        return result
    result["extractedCharacters"] = len(text.strip())
    check("page_limit", "passed" if 0 < result["pageCount"] <= payload.maxPages else "failed", "Page count checked against the selected limit")
    check("text_layer", "passed" if len(text.strip()) >= 60 else "failed", "At least 60 extractable characters are required")
    check("glyphs", "failed" if any(char in text for char in ("\ufffd", "\x00", "\ufffe")) else "passed", "Extraction checked for replacement and invalid glyphs")
    normalized = normalize(text)
    for index, required in enumerate(payload.requiredText):
        check(f"required_text_{index}", "passed" if normalize(required) in normalized else "failed", "Required applicant text checked")
    for index, term in enumerate(payload.supportedTerms):
        check(f"supported_term_{index}", "passed" if contains_term(text, term) else "failed", "Selected supported term checked")
    executable = shutil.which("pdftotext")
    if not executable:
        check("layout_bounds", "unavailable", "Poppler pdftotext is required for layout verification")
        return result
    try:
        process = subprocess.run([executable, "-bbox-layout", "-enc", "UTF-8", str(path), "-"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
        if process.returncode or len(process.stdout) > 5_000_000:
            raise ValueError("Poppler extraction failed")
        bbox = process.stdout.decode("utf-8")
        # Poppler emits one known doctype; strip it before parsing and disallow entities.
        bbox = re.sub(r'<!DOCTYPE[^>]*>', '', bbox)
        if "<!ENTITY" in bbox:
            raise ValueError("Unexpected XML entity")
        root = ET.fromstring(bbox)
        overflow = False
        margin_intrusion = False
        calibration = LAYOUT_MARGINS.get(payload.renderer)
        words = 0
        page_number = 0
        for page in root.iter():
            if page.tag.rsplit("}", 1)[-1] != "page":
                continue
            page_number += 1
            width, height = float(page.attrib["width"]), float(page.attrib["height"])
            page_words = [word for word in page.iter() if word.tag.rsplit("}", 1)[-1] == "word"]
            footer_words = []
            if payload.renderer == "cbs-letter-times" and payload.maxPages == 2:
                footer_words = [word for word in page_words
                                if float(word.attrib["xMin"]) >= width - CBS_PAGE_FOOTER["regionWidth"]
                                and float(word.attrib["xMax"]) <= width - CBS_PAGE_FOOTER["right"] + 5
                                and float(word.attrib["yMin"]) >= height - CBS_PAGE_FOOTER["regionHeight"]
                                and float(word.attrib["yMax"]) <= height - CBS_PAGE_FOOTER["bottom"] + 3]
                if normalize(" ".join(word.text or "" for word in footer_words)) != f"{page_number} / {result['pageCount']}":
                    footer_words = []
            for word in page.iter():
                if word.tag.rsplit("}", 1)[-1] != "word":
                    continue
                words += 1
                xmin, ymin, xmax, ymax = (float(word.attrib[key]) for key in ("xMin", "yMin", "xMax", "yMax"))
                if xmin < -1 or ymin < -1 or xmax > width + 1 or ymax > height + 1 or xmax <= xmin or ymax <= ymin:
                    overflow = True
                if calibration and word not in footer_words:
                    horizontal, vertical = calibration
                    if xmin < horizontal - 5 or ymin < vertical - 12 or xmax > width - horizontal + 5 or ymax > height - vertical + 12:
                        margin_intrusion = True
        if not calibration:
            check("renderer_margins", "unavailable", "No layout calibration exists for this renderer")
        else:
            check("renderer_margins", "failed" if margin_intrusion else "passed", "Positioned words checked against shipped renderer margins with calibrated glyph tolerance (5pt horizontal, 12pt vertical)")
        if words == 0:
            check("layout_bounds", "unavailable", "Poppler did not provide positioned words")
        else:
            check("layout_bounds", "failed" if overflow else "passed", "Positioned words checked against page boundaries; visual review remains required")
    except (OSError, subprocess.TimeoutExpired, ValueError, ET.ParseError, KeyError):
        check("layout_bounds", "unavailable", "Poppler layout verification could not complete")
    return result
