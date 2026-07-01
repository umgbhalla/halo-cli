"""Detached background jobs for long-running HALO work.

A job is just a HALO CLI command re-executed in its own session (``setsid``),
with stdout/stderr redirected to a logfile and metadata under a global registry
(``~/.halo/jobs/<id>/``). Because each job is its own session leader, it keeps
running after the launching shell exits and is queryable from any other shell.

No server process, no sockets — the "daemon" is the union of detached sessions
plus a filesystem registry. That's enough to start, list, tail, and cancel
multi-minute analysis runs without holding a terminal.
"""
from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

import typer

jobs_app = typer.Typer(no_args_is_help=True, help="Manage detached background jobs.")


def jobs_root() -> Path:
    root = Path(os.environ.get("HALO_HOME") or (Path.home() / ".halo")) / "jobs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _job_dir(job_id: str) -> Path:
    return jobs_root() / job_id


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _reexec_argv() -> list[str]:
    """Rebuild the current CLI invocation with the detach flags stripped."""
    argv = [a for a in sys.argv if a not in ("--detach", "-d")]
    # ``python -m halo_cli.main`` has no console-script argv[0]; re-exec via -m.
    if argv and argv[0].endswith("main.py"):
        return [sys.executable, "-m", "halo_cli.main", *argv[1:]]
    return argv


def spawn_detached(argv: list[str], *, name: str) -> str:
    """Launch ``argv`` in a new session, logging to the registry. Returns job id."""
    job_id = f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{name}"
    d = _job_dir(job_id)
    # Collision guard when two jobs start in the same second.
    suffix = 1
    while d.exists():
        job_id = f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{name}-{suffix}"
        d = _job_dir(job_id)
        suffix += 1
    d.mkdir(parents=True)

    log = d / "out.log"
    exit_file = d / "exitcode"
    inner = " ".join(shlex.quote(a) for a in argv)
    # Don't ``exec`` — we need the shell to survive the command and record its
    # exit code. start_new_session makes the shell a session/group leader so
    # cancel can signal the whole tree via the process group.
    wrapper = f'{inner} > {shlex.quote(str(log))} 2>&1; echo $? > {shlex.quote(str(exit_file))}'
    proc = subprocess.Popen(
        ["/bin/sh", "-c", wrapper],
        cwd=os.getcwd(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    (d / "meta.json").write_text(
        json.dumps(
            {
                "id": job_id,
                "name": name,
                "argv": argv,
                "pid": proc.pid,
                "cwd": os.getcwd(),
                "started_at": _utc(),
            },
            indent=2,
        )
    )
    return job_id


def detach_if_requested(detach: bool, *, name: str) -> None:
    """If ``detach`` is set, relaunch this command in the background and exit."""
    if not detach:
        return
    job_id = spawn_detached(_reexec_argv(), name=name)
    typer.echo(f"detached job {job_id}")
    typer.echo(f"  logs:   halo jobs logs {job_id} -f")
    typer.echo(f"  status: halo jobs status {job_id}")
    raise typer.Exit(0)


def _read_meta(job_id: str) -> dict:
    return json.loads((_job_dir(job_id) / "meta.json").read_text())


def _status(job_id: str) -> tuple[str, int | None]:
    d = _job_dir(job_id)
    exit_file = d / "exitcode"
    if exit_file.exists():
        raw = exit_file.read_text().strip()
        code = int(raw) if raw.lstrip("-").isdigit() else -1
        return ("done" if code == 0 else "failed", code)
    try:
        pid = _read_meta(job_id)["pid"]
    except (FileNotFoundError, KeyError):
        return ("unknown", None)
    return ("running", None) if _pid_alive(pid) else ("killed", None)


def _all_job_ids() -> list[str]:
    return sorted(p.name for p in jobs_root().iterdir() if (p / "meta.json").exists())


@jobs_app.command("list")
def list_jobs() -> None:
    """List all background jobs, newest last."""
    ids = _all_job_ids()
    if not ids:
        typer.echo("no jobs")
        return
    typer.echo(f"{'JOB ID':<32} {'STATUS':<9} {'PID':<8} STARTED")
    for job_id in ids:
        meta = _read_meta(job_id)
        state, code = _status(job_id)
        label = f"{state}({code})" if code not in (None, 0) else state
        typer.echo(f"{job_id:<32} {label:<9} {str(meta.get('pid','')):<8} {meta.get('started_at','')}")


@jobs_app.command("status")
def status(job_id: str) -> None:
    """Show one job's status, command, and log path."""
    if not (_job_dir(job_id) / "meta.json").exists():
        typer.echo(f"no such job: {job_id}", err=True)
        raise typer.Exit(1)
    meta = _read_meta(job_id)
    state, code = _status(job_id)
    typer.echo(f"id:      {job_id}")
    typer.echo(f"status:  {state}" + (f" (exit {code})" if code is not None else ""))
    typer.echo(f"pid:     {meta.get('pid')}")
    typer.echo(f"started: {meta.get('started_at')}")
    typer.echo(f"cwd:     {meta.get('cwd')}")
    typer.echo(f"cmd:     {' '.join(shlex.quote(a) for a in meta.get('argv', []))}")
    typer.echo(f"log:     {_job_dir(job_id) / 'out.log'}")


@jobs_app.command("logs")
def logs(
    job_id: str,
    follow: bool = typer.Option(False, "--follow", "-f", help="Stream new output until the job ends."),
    tail: int = typer.Option(0, "--tail", "-n", help="Show only the last N lines first (0 = all)."),
) -> None:
    """Print (and optionally follow) a job's output."""
    log = _job_dir(job_id) / "out.log"
    if not log.exists():
        typer.echo(f"no log yet for {job_id}", err=True)
        raise typer.Exit(1)
    with log.open("r", errors="replace") as fh:
        if tail > 0:
            lines = fh.readlines()
            for line in lines[-tail:]:
                sys.stdout.write(line)
            pos = fh.tell()
        else:
            sys.stdout.write(fh.read())
            pos = fh.tell()
        sys.stdout.flush()
        if not follow:
            return
        while True:
            fh.seek(pos)
            chunk = fh.read()
            if chunk:
                sys.stdout.write(chunk)
                sys.stdout.flush()
                pos = fh.tell()
            if _status(job_id)[0] != "running":
                # Final drain, then stop.
                fh.seek(pos)
                sys.stdout.write(fh.read())
                sys.stdout.flush()
                return
            time.sleep(0.5)


@jobs_app.command("cancel")
def cancel(job_id: str) -> None:
    """Terminate a running job (signals its whole process group)."""
    state, _ = _status(job_id)
    if state != "running":
        typer.echo(f"job {job_id} is not running ({state})")
        return
    pid = _read_meta(job_id)["pid"]
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except ProcessLookupError:
        typer.echo("process already gone")
        return
    typer.echo(f"sent SIGTERM to job {job_id} (pid {pid})")


@jobs_app.command("clean")
def clean(
    all_jobs: bool = typer.Option(False, "--all", help="Remove running jobs too (does not kill them)."),
) -> None:
    """Delete finished job records (done/failed/killed). Keeps running jobs unless --all."""
    import shutil

    removed = 0
    for job_id in _all_job_ids():
        state, _ = _status(job_id)
        if all_jobs or state in ("done", "failed", "killed", "unknown"):
            shutil.rmtree(_job_dir(job_id), ignore_errors=True)
            removed += 1
    typer.echo(f"removed {removed} job record(s)")
