from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

VERSION = 1
MAX_REQUEST_BYTES = 2_000_000
OPERATIONS = ("capabilities", "discover_jobs", "render_resume", "verify_document", "export_resume_yaml", "import_resume_yaml")


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Basics(Model):
    name: str = Field(min_length=1)
    headline: str | None = None
    email: str | None = None
    phone: str | None = None
    website: str | None = None
    linkedin: str | None = None
    github: str | None = None
    location: str | None = None


class Entry(Model):
    id: str | None = None


class Experience(Entry):
    company: str = Field(min_length=1)
    title: str = Field(min_length=1)
    location: str | None = None
    start: str
    end: str | None = None
    bullets: list[str]


class Project(Entry):
    name: str = Field(min_length=1)
    url: str | None = None
    description: str | None = None
    bullets: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    start: str | None = None
    end: str | None = None


class Skills(Entry):
    group: str = Field(min_length=1)
    items: list[str]


class Education(Entry):
    school: str = Field(min_length=1)
    degree: str = Field(min_length=1)
    start: str | None = None
    end: str | None = None
    details: list[str] = Field(default_factory=list)


class Publication(Entry):
    title: str = Field(min_length=1)
    authors: str | None = None
    venue: str | None = None
    year: str | None = None
    url: str | None = None
    doi: str | None = None


class Award(Entry):
    title: str = Field(min_length=1)
    issuer: str | None = None
    year: str | None = None
    description: str | None = None


class Certification(Entry):
    name: str = Field(min_length=1)
    issuer: str | None = None
    issued: str | None = None
    expires: str | None = None
    credentialId: str | None = None
    url: str | None = None


class CustomEntry(Entry):
    heading: str = Field(min_length=1)
    subheading: str | None = None
    meta: str | None = None
    bullets: list[str] = Field(default_factory=list)


class CustomSection(Entry):
    title: str = Field(min_length=1)
    entries: list[CustomEntry] = Field(default_factory=list)


class Resume(Model):
    basics: Basics
    summary: str | None = None
    experience: list[Experience] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    skills: list[Skills] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    publications: list[Publication] = Field(default_factory=list)
    awards: list[Award] = Field(default_factory=list)
    certifications: list[Certification] = Field(default_factory=list)
    sections: list[CustomSection] = Field(default_factory=list)


class Empty(Model):
    pass


class Discovery(Model):
    board: Literal["linkedin", "indeed", "google"]
    query: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    limit: int = Field(ge=1, le=20)


class ResumePayload(Model):
    resume: Resume


class Render(ResumePayload):
    renderer: Literal["rendercv-classic"]
    maxPages: Literal[1, 2]


class Verify(Model):
    filename: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    requiredText: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(max_length=100)
    supportedTerms: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(max_length=200)
    maxPages: Literal[1, 2]
    renderer: str = Field(min_length=1, max_length=80)


class Import(Model):
    bundleYaml: str = Field(min_length=1, max_length=1_000_000)
    expectedResume: Resume


class Envelope(Model):
    protocolVersion: Literal[1]
    requestId: str = Field(min_length=1, max_length=128)
    operation: Literal[*OPERATIONS]
    payload: dict

    @field_validator("payload")
    @classmethod
    def bounded_structure(cls, value):
        def walk(node, depth=0):
            if depth > 20:
                raise ValueError("Request nesting exceeds the protocol limit")
            if isinstance(node, dict):
                if len(node) > 1000:
                    raise ValueError("Request object exceeds the protocol limit")
                for item in node.values():
                    walk(item, depth + 1)
            elif isinstance(node, list):
                if len(node) > 1000:
                    raise ValueError("Request array exceeds the protocol limit")
                for item in node:
                    walk(item, depth + 1)
        walk(value)
        return value


PAYLOADS = {
    "capabilities": Empty,
    "discover_jobs": Discovery,
    "render_resume": Render,
    "verify_document": Verify,
    "export_resume_yaml": ResumePayload,
    "import_resume_yaml": Import,
}


class ToolError(Exception):
    def __init__(self, code: str, message: str, retryable=False):
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)


def dump_resume(resume: Resume) -> dict:
    # Preserve the distinction between an absent date and an explicitly supplied string.
    return resume.model_dump(exclude_unset=True)


Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
FileName = Annotated[str, Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")]


class Diagnostic(Model):
    code: str
    message: str


class CapabilitiesResult(Model):
    operations: list[Literal[*OPERATIONS]]
    components: dict[str, str]
    verifierVersion: Literal["1"]


class Lead(Model):
    source: Literal["linkedin", "indeed", "google"]
    sourceRowId: str = Field(min_length=1)
    originalUrl: str
    candidateDestinationUrl: str | None
    titleHint: str = Field(min_length=1)
    companyHint: str | None
    locationHint: str | None
    postedAt: str | None
    discoveredAt: str
    responseSha256: Hash
    resolutionStatus: Literal["unresolved"]


class DiscoveryResult(Model):
    board: Literal["linkedin", "indeed", "google"]
    status: Literal["complete", "empty", "partial", "blocked", "error"]
    leads: list[Lead] = Field(max_length=20)
    snapshotFilename: FileName | None
    responseSha256: Hash | None
    cooldownSeconds: int | None = Field(ge=0)
    diagnostics: list[Diagnostic] = Field(max_length=100)


class Check(Diagnostic):
    status: Literal["passed", "failed", "unavailable"]


class VerificationResult(Model):
    status: Literal["passed", "failed", "unavailable"]
    artifactSha256: Hash
    verifierVersion: Literal["1"]
    verifierConfigHash: Hash
    renderer: str
    pageCount: int | None = Field(ge=0)
    extractedCharacters: int = Field(ge=0)
    checks: list[Check] = Field(max_length=310)

    @field_validator("checks")
    @classmethod
    def check_passed_report(cls, checks, info):
        if info.data.get("status") != "passed":
            return checks
        required = {"artifact_hash", "page_limit", "text_layer", "glyphs", "renderer_margins", "layout_bounds"}
        codes = {check.code for check in checks}
        pages = info.data.get("pageCount")
        if (any(check.status != "passed" for check in checks) or not required.issubset(codes)
                or len(codes) != len(checks) or pages not in (1, 2) or info.data.get("extractedCharacters", 0) < 60):
            raise ValueError("Passed verification lacks successful bounded document checks")
        return checks


class RenderResult(Model):
    filename: FileName
    sha256: Hash
    sizeBytes: int = Field(gt=0)
    pageCount: int = Field(gt=0)
    renderer: Literal["rendercv-classic"]
    rendererVersion: str
    configSha256: Hash
    sourceSha256: Hash
    mappingFilename: FileName
    diagnostics: list[Diagnostic] = Field(max_length=100)


class ExportResult(Model):
    bundleYaml: str = Field(max_length=1_000_000)
    sourceSha256: Hash
    configSha256: Hash
    rendererVersion: str


class ImportedOperation(Model):
    kind: Literal["cut", "reorder", "rephrase"]
    path: str
    before: object
    after: object


class ImportResult(Model):
    sourceSha256: Hash
    requiresIndependentReview: Literal[True]
    operations: list[ImportedOperation] = Field(max_length=1000)
    diagnostics: list[Diagnostic] = Field(max_length=100)


RESULTS = {
    "capabilities": CapabilitiesResult,
    "discover_jobs": DiscoveryResult,
    "render_resume": RenderResult,
    "verify_document": VerificationResult,
    "export_resume_yaml": ExportResult,
    "import_resume_yaml": ImportResult,
}
