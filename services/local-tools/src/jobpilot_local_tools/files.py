import hashlib
import json
import os
from pathlib import Path

from .protocol import ToolError


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(value) -> str:
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())


def private_path(filename: str, *, must_exist=False) -> Path:
    if not filename or Path(filename).name != filename or filename in (".", ".."):
        raise ToolError("invalid_path", "Only filenames inside the operation directory are allowed")
    base = Path.cwd().resolve()
    path = base / filename
    if path.is_symlink() or path.resolve().parent != base:
        raise ToolError("invalid_path", "Symlinked artifacts are not allowed")
    if must_exist and (not path.is_file() or path.stat().st_size > 20_000_000):
        raise ToolError("invalid_artifact", "Artifact is missing or exceeds the size limit")
    return path


def write_private(filename: str, data: bytes) -> Path:
    path = private_path(filename)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
    except FileExistsError as error:
        raise ToolError("output_exists", "Operation output already exists") from error
    return path
