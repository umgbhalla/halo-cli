# HALO CLI

This package contains the `halo` console entry point registered in `pyproject.toml`.
It is a Typer app with subcommands:

- `analyze` — build an `EngineConfig` from flags/env and stream `stream_engine_async`
  over a JSONL trace file (`main.py`).
- `backfill` — incremental, rate-limit-aware Langfuse pull into `store/<project>.jsonl`
  (`backfill.py`).
- `convert` — raw Langfuse observations → HALO OTLP-shaped spans (`convert.py`).
- `pipeline` — backfill → convert → analyze in one command (`main.py`).
- `jobs` — detached background job registry: start/list/logs/status/cancel/clean (`jobs.py`).

`--detach` on `analyze`/`backfill`/`pipeline` re-execs the command in its own session and
records it under `~/.halo/jobs/`. Shared config helpers (`.env` loading, per-project Langfuse
credentials) live in `_env.py`.

User-facing installation, usage, options, jobs, and telemetry docs live in the root
[`README.md`](../README.md). Tests for argument parsing and config wiring live in
`tests/unit/test_halo_cli.py`.
