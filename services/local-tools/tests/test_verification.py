import hashlib
import shutil
import subprocess

import pytest
from pypdf import PdfWriter

from jobpilot_local_tools.documents import render
from jobpilot_local_tools.protocol import Render, Verify
from jobpilot_local_tools.verification import contains_term, verify


def payload(filename="test.pdf", data=b"bad pdf", **overrides):
    return Verify(filename=filename, sha256=hashlib.sha256(data).hexdigest(), requiredText=["Alex Example", "alex@example.com"],
                  supportedTerms=["C++", "C#", "PE", "VC", "AI"], maxPages=2, renderer="rendercv-classic", **overrides)


def test_whole_terms_keep_short_skills():
    assert contains_term("C++, C#, PE, VC and AI", "C++")
    assert contains_term("C++, C#, PE, VC and AI", "C#")
    assert not contains_term("Operations and Retail", "PE")
    assert not contains_term("Chair", "AI")
    assert not contains_term("C++", "C")


def test_hash_mismatch_fails_before_extraction(tmp_path):
    (tmp_path / "test.pdf").write_bytes(b"different")
    result = verify(payload())
    assert result["status"] == "failed"
    assert result["checks"][0]["code"] == "artifact_hash"


def test_unreadable_pdf_is_unavailable(tmp_path):
    (tmp_path / "test.pdf").write_bytes(b"bad pdf")
    assert verify(payload())["status"] == "unavailable"


def test_blank_pdf_has_no_text_layer(tmp_path):
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    path = tmp_path / "test.pdf"
    writer.write(path)
    result = verify(payload(data=path.read_bytes()))
    assert result["status"] == "failed"
    assert any(check["code"] == "text_layer" and check["status"] == "failed" for check in result["checks"])


def test_real_pdf_text_and_missing_poppler_hold(resume, monkeypatch):
    result = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    monkeypatch.setattr(shutil, "which", lambda _: None)
    verified = verify(Verify(filename=result["filename"], sha256=result["sha256"], requiredText=["Alex Example", "alex@example.com"],
                            supportedTerms=["C++", "C#", "PE", "VC", "AI"], maxPages=2, renderer="rendercv-classic"))
    assert verified["status"] == "unavailable"
    assert all(check["status"] == "passed" for check in verified["checks"] if check["code"] != "layout_bounds")


def test_overflow_is_failed(resume, monkeypatch):
    rendered = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    monkeypatch.setattr(shutil, "which", lambda _: "/fixed/pdftotext")
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0, b'<doc><page width="612" height="792"><word xMin="10" yMin="20" xMax="700" yMax="30">overflow</word></page></doc>', b''))
    result = verify(Verify(filename=rendered["filename"], sha256=rendered["sha256"], requiredText=["Alex Example"], supportedTerms=[], maxPages=2, renderer="rendercv-classic"))
    assert result["status"] == "failed"
    assert result["checks"][-1]["code"] == "layout_bounds"


def test_selected_term_and_contact_loss_fail(resume, monkeypatch):
    rendered = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    monkeypatch.setattr(shutil, "which", lambda _: None)
    result = verify(Verify(filename=rendered["filename"], sha256=rendered["sha256"], requiredText=["missing@example.com"], supportedTerms=["NoSuchTerm"], maxPages=2, renderer="rendercv-classic"))
    assert result["status"] == "failed"
    assert sum(check["status"] == "failed" for check in result["checks"]) == 2


def test_real_poppler_margin_calibration(resume):
    if not shutil.which("pdftotext"):
        pytest.skip("Poppler is not installed")
    rendered = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    result = verify(Verify(filename=rendered["filename"], sha256=rendered["sha256"], requiredText=["Alex Example", "alex@example.com"], supportedTerms=["C++", "C#"], maxPages=2, renderer="rendercv-classic"))
    assert result["status"] == "passed", result["checks"]


def test_cbs_footer_exemption_accepts_only_exact_shipped_footer(resume, monkeypatch):
    rendered = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    monkeypatch.setattr(shutil, "which", lambda _: "/fixed/pdftotext")
    def result_for(text, xmax="572"):
        bbox = f'<doc><page width="612" height="792"><word xMin="550" yMin="772" xMax="{xmax}" yMax="781">{text}</word></page></doc>'.encode()
        monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0, bbox, b''))
        return verify(Verify(filename=rendered["filename"], sha256=rendered["sha256"], requiredText=[], supportedTerms=[], maxPages=2, renderer="cbs-letter-times"))
    valid_footer = f"1 / {rendered['pageCount']}"
    assert result_for(valid_footer)["status"] == "passed"
    for text in ("1 / 999", "New body text", f"{valid_footer} additional"):
        assert result_for(text)["status"] == "failed"
    assert result_for(valid_footer, "620")["status"] == "failed"


@pytest.mark.parametrize("text", ["financial-modeling", "financial–modeling", "financial—modeling", "financial\u2011modeling"])
def test_fit_term_normalization_agrees_on_hyphenated_phrases(text):
    assert contains_term(text, "financial modeling")
    assert contains_term("financial modeling", text)


def test_fit_term_boundaries_preserve_short_terms_and_languages():
    for term in ("PE", "VC", "AI", "C++", "C#"):
        assert contains_term(f"Tools: {term}_research", term)
    assert not contains_term("Retail leadership", "AI")
    assert not contains_term("PEPE", "PE")
    assert not contains_term("C++", "C")
