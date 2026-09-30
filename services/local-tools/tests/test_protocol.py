import json
import os
import subprocess
import sys

import pytest

from jobpilot_local_tools.__main__ import handle
from jobpilot_local_tools.files import private_path, write_private
from jobpilot_local_tools.protocol import ToolError


def request(operation="capabilities", payload=None):
    return json.dumps({"protocolVersion": 1, "requestId": "test", "operation": operation, "payload": payload or {}}).encode()


def test_capabilities():
    result = handle(request())
    assert result["status"] == "ok"
    assert result["result"]["components"]["rendercv"] == "2.8"
    assert "verify_document" in result["result"]["operations"]


@pytest.mark.parametrize("raw", [b"{}", b"not json", b"[]", b"x" * 2_000_001,
    b'{"protocolVersion":2,"requestId":"x","operation":"capabilities","payload":{}}'])
def test_invalid_requests_are_redacted(raw):
    result = handle(raw)
    assert result["status"] == "error"
    assert "Traceback" not in json.dumps(result)


def test_discovery_limits_and_unsupported_operation():
    assert handle(request("discover_jobs", {"board": "indeed", "query": "analyst", "limit": 21}))["status"] == "error"
    assert handle(request("discover_jobs", {"board": "glassdoor", "query": "analyst", "limit": 1}))["status"] == "error"
    assert handle(request("submit_application"))["status"] == "error"


def test_protocol_stdout_is_one_json_line():
    output = subprocess.run([sys.executable, "-m", "jobpilot_local_tools"], input=request(), capture_output=True, check=True)
    assert len(output.stdout.splitlines()) == 1
    assert json.loads(output.stdout)["status"] == "ok"


def test_private_paths_and_no_overwrite(tmp_path):
    with pytest.raises(ToolError):
        private_path("../outside")
    (tmp_path / "linked.pdf").symlink_to(tmp_path.parent / "outside.pdf")
    with pytest.raises(ToolError):
        private_path("linked.pdf")
    artifact = write_private("test.json", b"{}")
    assert artifact.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ToolError):
        write_private("test.json", b"changed")


def test_shared_typescript_python_source_hash_fixture():
    from pathlib import Path
    from jobpilot_local_tools.files import canonical_hash
    fixture = json.loads((Path(__file__).parent / "fixtures" / "protocol.json").read_text())
    assert canonical_hash(fixture["source"]) == fixture["sourceSha256"]
    result = handle(json.dumps(fixture["request"]).encode())
    assert result["status"] == "ok"
    assert result["result"]["sourceSha256"] == fixture["sourceSha256"]


@pytest.mark.parametrize("missing", ["artifact_hash", "page_limit", "text_layer", "glyphs", "renderer_margins", "layout_bounds"])
def test_success_verification_cannot_omit_required_checks(missing):
    from pydantic import ValidationError
    from jobpilot_local_tools.protocol import VerificationResult
    from jobpilot_local_tools.verification import verifier_config_hash
    required = ["artifact_hash", "page_limit", "text_layer", "glyphs", "renderer_margins", "layout_bounds"]
    with pytest.raises(ValidationError):
        VerificationResult(status="passed", artifactSha256="a" * 64, verifierVersion="1", verifierConfigHash=verifier_config_hash(),
                           renderer="rendercv-classic", pageCount=1, extractedCharacters=100,
                           checks=[{"code": code, "status": "passed", "message": "Synthetic check"} for code in required if code != missing])
