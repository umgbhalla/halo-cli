"""Incremental, rate-limit-aware Langfuse backfill into a per-project store."""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import typer

from halo_cli._env import langfuse_credentials, project_env_key


def store_dir() -> Path:
    d = Path.cwd() / "store"
    d.mkdir(exist_ok=True)
    return d


class _RateLimiter:
    def __init__(self, min_interval: float) -> None:
        self._min = min_interval
        self._last = 0.0

    def wait(self) -> None:
        if self._min <= 0:
            return
        gap = time.monotonic() - self._last
        if gap < self._min:
            time.sleep(self._min - gap)
        self._last = time.monotonic()


def _fetch_page(base_url: str, auth: str, params: dict, limiter: _RateLimiter, *, attempts: int = 6) -> dict:
    url = f"{base_url}/api/public/observations?{urllib.parse.urlencode(params)}"
    for attempt in range(1, attempts + 1):
        limiter.wait()
        req = urllib.request.Request(url, headers={"authorization": auth})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise typer.Exit(2) from exc
            if exc.code == 429:
                retry_after = exc.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else min(30, 2**attempt)
                typer.echo(f"  429 rate-limited; sleeping {delay:.0f}s", err=True)
                time.sleep(delay)
                continue
            if exc.code >= 500 and attempt < attempts:
                time.sleep(min(30, 2**attempt))
                continue
            typer.echo(f"HTTP {exc.code} from Langfuse: {exc.read()[:300]!r}", err=True)
            raise typer.Exit(1) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == attempts:
                typer.echo(f"Network error talking to Langfuse: {exc}", err=True)
                raise typer.Exit(1) from exc
            time.sleep(min(30, 2**attempt))
    raise typer.Exit(1)


def backfill_project(project: str, *, limit: int, min_interval: float, max_pages: int, full: bool) -> dict:
    """Backfill one project. Incremental unless ``full``. Returns a summary dict."""
    creds = langfuse_credentials(project)
    if creds is None:
        key = project_env_key(project)
        return {
            "project": project,
            "skipped": f"missing LANGFUSE_BASE_URL / LANGFUSE_{key}_PUBLIC_KEY / _SECRET_KEY",
        }
    base_url, pk, sk = creds
    auth = "Basic " + base64.b64encode(f"{pk}:{sk}".encode()).decode()
    limiter = _RateLimiter(min_interval)

    store_path = store_dir() / f"{project}.jsonl"
    cursor_path = store_dir() / f"{project}.cursor"
    since = None if full else (cursor_path.read_text().strip() if cursor_path.exists() else None)

    params_base: dict = {"limit": min(limit, 100)}
    if since:
        params_base["fromStartTime"] = since

    written = 0
    high_water = since
    page = 1
    with store_path.open("a") as out:
        while True:
            body = _fetch_page(base_url, auth, {**params_base, "page": page}, limiter)
            rows = body.get("data") or []
            if not rows:
                break
            for row in rows:
                start = row.get("startTime")
                if since and start == since:
                    continue
                out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                written += 1
                if start and (high_water is None or start > high_water):
                    high_water = start
            total_pages = (body.get("meta") or {}).get("totalPages") or page
            typer.echo(f"  {project} page {page}/{total_pages}  +{written}", err=True)
            if page >= total_pages or (max_pages and page >= max_pages):
                break
            page += 1

    if high_water:
        cursor_path.write_text(high_water)
    return {"project": project, "store": str(store_path), "new_observations": written, "cursor": high_water}


def backfill_command(
    project: list[str] = typer.Option(..., "--project", "-p", help="Project name (repeatable)."),
    limit: int = typer.Option(100, "--limit", help="Page size (max 100)."),
    min_interval: float = typer.Option(0.25, "--min-interval", help="Min seconds between requests."),
    max_pages: int = typer.Option(0, "--max-pages", help="Stop after N pages per project (0 = all)."),
    full: bool = typer.Option(False, "--full", help="Ignore the cursor and re-pull from the beginning."),
    detach: bool = typer.Option(False, "--detach", "-d", help="Run in the background as a detached job."),
) -> None:
    """Backfill Langfuse observations into store/<project>.jsonl (incremental)."""
    from halo_cli.jobs import detach_if_requested

    detach_if_requested(detach, name="backfill")
    results = [
        backfill_project(p, limit=limit, min_interval=min_interval, max_pages=max_pages, full=full)
        for p in project
    ]
    sys.stdout.write(json.dumps({"results": results}, indent=2) + "\n")
