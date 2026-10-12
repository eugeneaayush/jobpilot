import contextlib
import importlib.metadata
import json
import os
import sys

from pydantic import ValidationError

from .protocol import Envelope, MAX_REQUEST_BYTES, OPERATIONS, PAYLOADS, RESULTS, ToolError


def dispatch(request):
    payload = PAYLOADS[request.operation].model_validate(request.payload)
    if request.operation == "capabilities":
        return {"operations": list(OPERATIONS), "components": {
            name: importlib.metadata.version(name) for name in ("jobpilot-local-tools", "jobpilot-jobspy", "rendercv", "rendercv-fonts", "typst", "pypdf")
        }, "verifierVersion": "1"}
    if request.operation == "discover_jobs":
        from .discovery import discover
        return discover(payload)
    if request.operation == "verify_document":
        from .verification import verify
        return verify(payload)
    from .documents import export_yaml, import_yaml, render
    return {"render_resume": render, "export_resume_yaml": export_yaml, "import_resume_yaml": import_yaml}[request.operation](payload)


def handle(raw):
    request = None
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise ToolError("request_too_large", "Request exceeds the size limit")
        request = Envelope.model_validate_json(raw)
        with contextlib.redirect_stdout(sys.stderr):
            value = dispatch(request)
        try:
            result = RESULTS[request.operation].model_validate(value).model_dump()
        except ValidationError as invalid_output:
            raise ToolError("invalid_output", "Operation result does not match the local tools protocol") from invalid_output
        return {"protocolVersion": 1, "requestId": request.requestId, "operation": request.operation, "status": "ok", "result": result}
    except (ValidationError, ValueError):
        error = ToolError("invalid_request", "Request does not match the local tools protocol")
    except ToolError as caught:
        error = caught
    except (ImportError, importlib.metadata.PackageNotFoundError):
        error = ToolError("component_unavailable", "A required locked component is unavailable")
    except Exception:
        # No dependency traceback, resume contents, network body or filesystem path crosses stdout.
        error = ToolError("operation_failed", "Local operation could not complete")
    return {"protocolVersion": 1, "requestId": request.requestId if request else "invalid-request",
            "operation": request.operation if request else "capabilities", "status": "error",
            "error": {"code": error.code, "message": error.message, "retryable": error.retryable}}


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    response = handle(raw)
    encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode()) > 2_000_000:
        response = {"protocolVersion": 1, "requestId": response["requestId"], "operation": response["operation"],
                    "status": "error", "error": {"code": "output_too_large", "message": "Operation output exceeds the protocol limit", "retryable": False}}
        encoded = json.dumps(response, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")


if __name__ == "__main__":
    main()
