import copy
import importlib.metadata
import io
import json
import re
import tempfile
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.tokens import AliasToken, AnchorToken, TagToken

from .files import canonical_hash, digest, private_path, write_private
from .protocol import Import, Render, ResumePayload, ToolError, dump_resume

RENDERER = "rendercv-classic"
DESIGN = {"theme": "classic", "page": {"size": "us-letter", "show_footer": False, "show_top_note": False}}
MAPPING_VERSION = 1


def version():
    return importlib.metadata.version("rendercv")


def config_hash():
    return canonical_hash({"renderer": RENDERER, "design": DESIGN, "version": version(), "mappingVersion": MAPPING_VERSION,
                           "typstVersion": importlib.metadata.version("typst"), "fontsVersion": importlib.metadata.version("rendercv-fonts"),
                           "fontFamilies": ["Source Sans 3", "Font Awesome 7", "Noto Sans"]})


def safe_text(value):
    if isinstance(value, str):
        if re.search(r"#[A-Za-z]|!\[|<[/!A-Za-z]|\$\$", value):
            raise ToolError("unsafe_markup", "Raw Typst, math, HTML and resource markup are not supported")
    elif isinstance(value, list):
        for item in value:
            safe_text(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            safe_text(key)
            safe_text(item)


def joined(*values):
    return " · ".join(str(value) for value in values if value)


def dates(entry, start="start", end="end"):
    return " – ".join(entry[key] for key in (start, end) if entry.get(key))


def build_mapping(resume):
    safe_text(resume)
    basics = resume["basics"]
    cv = {"name": basics["name"], "sections": {}}
    # Contact strings stay verbatim; renderer-specific phone/date normalization cannot invent facts.
    contact = [basics.get(key) for key in ("headline", "email", "phone", "website", "linkedin", "github", "location") if basics.get(key)]
    if contact:
        cv["sections"]["Contact"] = [{"name": "Contact", "highlights": contact}]
    mapping = []

    def add(section, entries, source_path, convert, editable):
        if not entries:
            return
        label = section
        suffix = 2
        while label in cv["sections"]:
            label = f"{section} ({suffix})"
            suffix += 1
        values = [convert(entry) for entry in entries]
        cv["sections"][label] = values
        mapping.append({"section": label, "path": source_path, "entries": [
            {"path": f"{source_path}/{index}", "id": entry.get("id"), "original": value, "editable": editable}
            for index, (entry, value) in enumerate(zip(entries, values, strict=True))
        ]})

    if resume.get("summary"):
        cv["sections"]["Summary"] = [resume["summary"]]
        mapping.append({"section": "Summary", "path": "/summary", "entries": []})
    add("Experience", resume.get("experience", []), "/experience", lambda e: {
        "name": joined(e["company"], e["title"]), "date": dates(e), "location": e.get("location", ""), "highlights": e["bullets"],
    }, {"highlights": "bullets"})
    add("Education", resume.get("education", []), "/education", lambda e: {
        "name": joined(e["school"], e["degree"]), "date": dates(e), "highlights": e.get("details", []),
    }, {"highlights": "details"})
    add("Projects", resume.get("projects", []), "/projects", lambda e: {
        "name": joined(e["name"], e.get("url")), "date": dates(e),
        "summary": joined(e.get("description"), ", ".join(e.get("keywords", []))), "highlights": e.get("bullets", []),
    }, {"highlights": "bullets"})
    add("Skills", resume.get("skills", []), "/skills", lambda e: {
        "name": e["group"], "highlights": e["items"],
    }, {"highlights": "items"})
    add("Publications", resume.get("publications", []), "/publications", lambda e: {
        "name": e["title"], "date": e.get("year", ""),
        "summary": joined(e.get("authors"), e.get("venue"), e.get("doi"), e.get("url")),
    }, {})
    add("Awards", resume.get("awards", []), "/awards", lambda e: {
        "name": joined(e["title"], e.get("issuer")), "date": e.get("year", ""), "summary": e.get("description", ""),
    }, {})
    add("Certifications", resume.get("certifications", []), "/certifications", lambda e: {
        "name": joined(e["name"], e.get("issuer")), "date": dates(e, "issued", "expires"),
        "summary": joined(e.get("credentialId"), e.get("url")),
    }, {})
    for index, section in enumerate(resume.get("sections", [])):
        add(section["title"], section.get("entries", []), f"/sections/{index}/entries", lambda e: {
            "name": joined(e["heading"], e.get("subheading")), "date": e.get("meta", ""), "highlights": e.get("bullets", []),
        }, {"highlights": "bullets"})
    return {"cv": cv, "design": copy.deepcopy(DESIGN)}, mapping


def bundle(resume):
    rendercv, mapping = build_mapping(resume)
    return {"jobpilot": {"version": MAPPING_VERSION, "sourceSha256": canonical_hash(resume),
                         "source": resume, "mapping": mapping, "configSha256": config_hash()}, "rendercv": rendercv}


def export_yaml(payload: ResumePayload):
    data = bundle(dump_resume(payload.resume))
    yaml = YAML(typ="safe")
    yaml.default_flow_style = False
    yaml.sort_base_mapping_type_on_output = False
    yaml.representer.ignore_aliases = lambda _: True
    stream = io.StringIO()
    yaml.dump(data, stream)
    result = stream.getvalue()
    if len(result) > 1_000_000:
        raise ToolError("output_too_large", "YAML bundle exceeds the protocol limit")
    return {"bundleYaml": result, "sourceSha256": data["jobpilot"]["sourceSha256"], "configSha256": config_hash(), "rendererVersion": version()}


def parse_yaml(text):
    yaml = YAML(typ="safe")
    try:
        for token in yaml.scan(text):
            if isinstance(token, (AliasToken, AnchorToken, TagToken)):
                raise ToolError("unsafe_yaml", "YAML aliases, anchors and tags are not supported")
        value = yaml.load(text)
    except ToolError:
        raise
    except Exception as error:
        raise ToolError("invalid_yaml", "Cannot read the JobPilot YAML bundle") from error
    if not isinstance(value, dict):
        raise ToolError("invalid_yaml", "Expected a JobPilot YAML bundle")
    return value


def import_yaml(payload: Import):
    original = bundle(dump_resume(payload.expectedResume))
    changed = parse_yaml(payload.bundleYaml)
    if set(changed) != {"jobpilot", "rendercv"} or changed["jobpilot"] != original["jobpilot"]:
        raise ToolError("stale_or_modified_source", "Bundle metadata must match the current accepted source exactly")
    document = changed["rendercv"]
    if not isinstance(document, dict) or set(document) != {"cv", "design"} or document["design"] != DESIGN:
        raise ToolError("unsupported_configuration", "Only the bundled renderer configuration is supported")
    safe_text(document)
    cv = document["cv"]
    expected_cv = original["rendercv"]["cv"]
    if not isinstance(cv, dict) or set(cv) != set(expected_cv) or cv.get("name") != expected_cv["name"]:
        raise ToolError("protected_fact_changed", "Applicant identity cannot be changed through YAML")
    sections = cv.get("sections")
    if not isinstance(sections, dict) or set(sections) - set(expected_cv["sections"]):
        raise ToolError("unsupported_sections", "YAML cannot add sections or facts")
    expected_order = [name for name in expected_cv["sections"] if name in sections]
    if list(sections) != expected_order:
        raise ToolError("unsupported_section_order", "Section ordering changes are not supported; preserve the exported section order")
    if sections.get("Contact") != expected_cv["sections"].get("Contact"):
        raise ToolError("protected_fact_changed", "Contact information cannot be changed through YAML")
    operations = []
    for group in original["jobpilot"]["mapping"]:
        section, path = group["section"], group["path"]
        before = expected_cv["sections"][section]
        after = sections.get(section, [])
        if not isinstance(after, list):
            raise ToolError("invalid_entries", "Sections must contain arrays of entries")
        if after == before:
            continue
        if path == "/summary":
            if len(after) > 1 or (after and not isinstance(after[0], str)):
                raise ToolError("invalid_entries", "The summary supports one text entry")
            if after != before:
                raise ToolError("protected_fact_changed", "Summary changes must use the existing reviewed source workflow")
            continue
        seen = []
        for entry in after:
            if not isinstance(entry, dict):
                raise ToolError("invalid_entries", "Only mapped generic entries are supported")
            matches = []
            for index, source in enumerate(group["entries"]):
                protected_before = {k: v for k, v in source["original"].items() if k not in source["editable"]}
                protected_after = {k: v for k, v in entry.items() if k not in source["editable"]}
                if protected_before == protected_after:
                    matches.append(index)
            if len(matches) != 1 or matches[0] in seen:
                raise ToolError("protected_fact_changed", "Modified identity, dates, duplicate or ambiguous entries require a source update")
            index = matches[0]
            seen.append(index)
            source = group["entries"][index]
            for field, source_field in source["editable"].items():
                old = source["original"].get(field, [])
                new = entry.get(field, [])
                if not isinstance(new, list) or any(not isinstance(line, str) for line in new) or len(new) > len(old):
                    raise ToolError("unsupported_edit", "Only cut, reorder and rephrase edits are supported")
                if old == new:
                    continue
                reject_new_numbers(old, new)
                if source_field == "items" and any(item not in old for item in new):
                    raise ToolError("protected_fact_changed", "New skills require an accepted source update")
                if all(item in old for item in new):
                    if len(set(new)) != len(new):
                        raise ToolError("unsupported_edit", "Duplicated lines are not supported")
                    kind = "cut" if len(new) < len(old) else "reorder"
                    operations.append({"kind": kind, "path": f"{source['path']}/{source_field}", "before": old, "after": new})
                else:
                    if path not in ("/experience", "/projects") or source_field != "bullets":
                        raise ToolError("unsupported_edit", "Only experience and project bullets support reviewed rephrases")
                    if len(old) != len(new) or any(line in old and line != old[position] for position, line in enumerate(new)):
                        raise ToolError("unsupported_edit", "Do not combine rephrases with cuts or reorders in one bullet array")
                    for position, (old_line, new_line) in enumerate(zip(old, new, strict=True)):
                        if old_line != new_line:
                            operations.append({"kind": "rephrase", "path": f"{source['path']}/{source_field}/{position}", "before": old_line, "after": new_line})
        indices = list(range(len(group["entries"])))
        if seen != indices:
            operations.append({"kind": "cut" if len(seen) < len(indices) else "reorder", "path": path, "before": indices, "after": seen})
    if len(operations) > 1000:
        raise ToolError("too_many_edits", "YAML import exceeds the edit limit")
    return {"sourceSha256": original["jobpilot"]["sourceSha256"], "requiresIndependentReview": True,
            "operations": operations, "diagnostics": []}


def reject_new_numbers(before, after):
    existing = set(re.findall(r"\d+(?:[.,]\d+)*(?:%|[kKmMbB])?", json.dumps(before)))
    proposed = set(re.findall(r"\d+(?:[.,]\d+)*(?:%|[kKmMbB])?", json.dumps(after)))
    if proposed - existing:
        raise ToolError("unsupported_numeric_claim", "New numeric claims require an accepted source update")


def render(payload: Render):
    import rendercv_fonts
    import typst
    from pypdf import PdfReader
    from rendercv.renderer.pdf_png import get_package_path
    from rendercv.renderer.templater.templater import render_full_template
    from rendercv.schema.models.rendercv_model import RenderCVModel

    data = bundle(dump_resume(payload.resume))
    document = data["rendercv"]
    model = RenderCVModel.model_validate(document)
    for filename in ("resume.pdf", "resume.typ", "mapping.json"):
        if private_path(filename).exists():
            raise ToolError("output_exists", "Operation output already exists")
    text = render_full_template(model, "typst")
    typst_file = write_private("resume.typ", text.encode())
    # The complete distribution includes its only Typst package; keep all caches local.
    previous_temp = tempfile.tempdir
    tempfile.tempdir = str(Path.cwd())
    try:
        get_package_path.cache_clear()
        package_path = get_package_path()
        compiler = typst.Compiler(root=Path.cwd(), font_paths=[rendercv_fonts.path_of[name] for name in ("Source Sans 3", "Font Awesome 7", "Noto Sans")],
                                  ignore_system_fonts=True,
                                  package_path=package_path, package_cache_path=package_path)
        pdf = compiler.compile(input=typst_file, format="pdf")
    finally:
        tempfile.tempdir = previous_temp
    path = write_private("resume.pdf", pdf)
    page_count = len(PdfReader(path).pages)
    write_private("mapping.json", json.dumps(data["jobpilot"], ensure_ascii=False).encode())
    diagnostics = []
    if page_count > payload.maxPages:
        diagnostics.append({"code": "page_limit", "message": "Rendered document exceeds the selected page limit"})
    return {"filename": path.name, "sha256": digest(pdf), "sizeBytes": len(pdf), "pageCount": page_count,
            "renderer": RENDERER, "rendererVersion": version(), "configSha256": config_hash(),
            "sourceSha256": data["jobpilot"]["sourceSha256"], "mappingFilename": "mapping.json", "diagnostics": diagnostics}
