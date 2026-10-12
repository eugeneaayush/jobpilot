import copy
import io
import json

import pytest
from pypdf import PdfReader
from ruamel.yaml import YAML

from jobpilot_local_tools.documents import build_mapping, export_yaml, import_yaml, render
from jobpilot_local_tools.protocol import Import, Render, ResumePayload, ToolError


def rewrite(text, mutation):
    yaml = YAML(typ="safe")
    yaml.sort_base_mapping_type_on_output = False
    data = yaml.load(text)
    mutation(data)
    output = io.StringIO()
    yaml.dump(data, output)
    return output.getvalue()


def test_mapping_preserves_all_facts_without_present(resume):
    document, mapping = build_mapping(resume)
    encoded = json.dumps(document, ensure_ascii=False)
    assert "Present" not in encoded
    for value in ("Fall 2020", "MBA / MS", "Alex Example, Taylor Sample et al.", "10.1000/example", "https://example.com/note", "ABC-123", "C++", "C#"):
        assert value in encoded
    assert any(entry["id"] == "work-1" for group in mapping for entry in group["entries"])


def test_yaml_roundtrip(resume):
    exported = export_yaml(ResumePayload(resume=resume))
    imported = import_yaml(Import(bundleYaml=exported["bundleYaml"], expectedResume=resume))
    assert imported["operations"] == []
    assert imported["requiresIndependentReview"] is True


def test_import_is_proposed_rephrase_only(resume):
    original = export_yaml(ResumePayload(resume=resume))
    updated = rewrite(original["bundleYaml"], lambda value: value["rendercv"]["cv"]["sections"]["Experience"][0]["highlights"].__setitem__(1, "Prepared investment research for the team."))
    imported = import_yaml(Import(bundleYaml=updated, expectedResume=resume))
    assert imported["operations"][0]["kind"] == "rephrase"
    assert imported["operations"][0]["path"] == "/experience/0/bullets/1"
    assert resume["experience"][0]["bullets"][1] == "Prepared research for the investment team."


@pytest.mark.parametrize("field,value", [("name", "Fake Employer · CEO"), ("date", "2020 – Present"), ("location", "London")])
def test_protected_employer_title_and_date_changes_fail(resume, field, value):
    original = export_yaml(ResumePayload(resume=resume))
    changed = rewrite(original["bundleYaml"], lambda data: data["rendercv"]["cv"]["sections"]["Experience"][0].__setitem__(field, value))
    with pytest.raises(ToolError, match="identity|dates"):
        import_yaml(Import(bundleYaml=changed, expectedResume=resume))


def test_fake_numeric_claim_and_skill_fail(resume):
    original = export_yaml(ResumePayload(resume=resume))["bundleYaml"]
    for section, line in (("Experience", "Generated $500 million in revenues"), ("Skills", "InventedTechnology")):
        changed = rewrite(original, lambda data: data["rendercv"]["cv"]["sections"][section][0]["highlights"].__setitem__(0, line))
        with pytest.raises(ToolError):
            import_yaml(Import(bundleYaml=changed, expectedResume=resume))


def test_import_cut_and_reorder(resume):
    original = export_yaml(ResumePayload(resume=resume))["bundleYaml"]
    changed = rewrite(original, lambda data: data["rendercv"]["cv"]["sections"].pop("Awards"))
    result = import_yaml(Import(bundleYaml=changed, expectedResume=resume))
    assert result["operations"] == [{"kind": "cut", "path": "/awards", "before": [0], "after": []}]


@pytest.mark.parametrize("mutation", [
    lambda data: data["rendercv"].__setitem__("settings", {"render_command": {"output_folder": "/tmp/escape"}}),
    lambda data: data["rendercv"]["design"].__setitem__("theme", "/tmp/custom.py"),
    lambda data: data["jobpilot"]["source"]["basics"].__setitem__("name", "Changed"),
])
def test_reject_arbitrary_resources_and_metadata(resume, mutation):
    original = export_yaml(ResumePayload(resume=resume))["bundleYaml"]
    with pytest.raises(ToolError):
        import_yaml(Import(bundleYaml=rewrite(original, mutation), expectedResume=resume))


def test_reject_yaml_aliases_and_typst_commands(resume):
    with pytest.raises(ToolError):
        import_yaml(Import(bundleYaml="a: &a [*a]", expectedResume=resume))
    resume["summary"] = '#read("/etc/passwd")'
    with pytest.raises(ToolError):
        export_yaml(ResumePayload(resume=resume))


def test_real_rendercv_distribution_renders_facts(resume):
    result = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    assert result["rendererVersion"] == "2.8"
    assert result["sizeBytes"] > 1000
    text = " ".join(page.extract_text() for page in PdfReader(result["filename"]).pages)
    for value in ("Alex Example", "alex@example.com", "Example Capital", "Fall 2020", "MBA / MS", "ABC-123"):
        assert value in text
    assert "Present" not in text


def test_unedited_duplicate_entries_roundtrip_preserves_ids(resume):
    duplicate = copy.deepcopy(resume["experience"][0])
    duplicate["id"] = "work-duplicate"
    resume["experience"].append(duplicate)
    exported = export_yaml(ResumePayload(resume=resume))
    imported = import_yaml(Import(bundleYaml=exported["bundleYaml"], expectedResume=resume))
    assert imported["operations"] == []


def test_legitimate_dollar_metrics_render_as_text(resume):
    resume["experience"][0]["bullets"] = ["Analyzed $10 million in investments."]
    result = render(Render(resume=resume, renderer="rendercv-classic", maxPages=2))
    text = " ".join(page.extract_text() for page in PdfReader(result["filename"]).pages)
    assert "$10 million" in text


def test_rejects_unsupported_section_reordering(resume):
    original = export_yaml(ResumePayload(resume=resume))["bundleYaml"]
    def swap(data):
        sections = data["rendercv"]["cv"]["sections"]
        keys = list(sections)
        keys[0], keys[1] = keys[1], keys[0]
        data["rendercv"]["cv"]["sections"] = {key: sections[key] for key in keys}
    with pytest.raises(ToolError) as error:
        import_yaml(Import(bundleYaml=rewrite(original, swap), expectedResume=resume))
    assert error.value.code == "unsupported_section_order"
