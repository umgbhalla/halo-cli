"""Shared config helpers: .env loading and per-project Langfuse credentials."""
from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader (KEY=VALUE, ignores blanks/comments). No deps.

    Existing environment variables win, so an explicit shell export overrides
    the file. Searches CWD then the repo root when ``path`` is not given.
    """
    if path is None:
        for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"):
            if candidate.exists():
                path = candidate
                break
    if path is None or not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def project_env_key(project: str) -> str:
    return project.upper().replace("-", "_").replace(" ", "_")


def langfuse_credentials(project: str) -> tuple[str, str, str] | None:
    """Return (base_url, public_key, secret_key) for a project, or None if unset."""
    base = (os.environ.get("LANGFUSE_BASE_URL") or "").strip().rstrip("/")
    key = project_env_key(project)
    pk = (os.environ.get(f"LANGFUSE_{key}_PUBLIC_KEY") or "").strip()
    sk = (os.environ.get(f"LANGFUSE_{key}_SECRET_KEY") or "").strip()
    if base and pk and sk:
        return base, pk, sk
    return None
