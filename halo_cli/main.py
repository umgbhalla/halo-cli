"""`halo` CLI: analyze traces, backfill from Langfuse, and run detached jobs."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import get_args

import typer
from pydantic import TypeAdapter, ValidationError
from rich.console import Console
from rich.rule import Rule

from engine.agents.agent_config import AgentConfig
from engine.code.code_repo import find_ripgrep
from engine.engine_config import EngineConfig
from engine.main import stream_engine_async
from engine.model_config import ModelConfig, ReasoningEffort
from engine.model_provider_config import ModelProviderConfig
from engine.models.engine_output import AgentOutputItem, AgentTextDelta
from engine.models.messages import AgentMessage
from halo_cli._env import load_dotenv
from halo_cli.backfill import backfill_command, backfill_project
from halo_cli.convert import convert as convert_traces
from halo_cli.convert import convert_command
from halo_cli.jobs import detach_if_requested, jobs_app

console = Console()

REASONING_EFFORT_CHOICES: tuple[str, ...] = get_args(ReasoningEffort)
_REASONING_EFFORT_ADAPTER: TypeAdapter[ReasoningEffort | None] = TypeAdapter(ReasoningEffort | None)

DEFAULT_PROMPT = (
    "Analyze these traces. Identify the most important failures, latency "
    "bottlenecks, confusing tool behavior, and concrete improvements for the developer."
)


def _parse_reasoning_effort(value: str | None) -> ReasoningEffort | None:
    try:
        return _REASONING_EFFORT_ADAPTER.validate_python(value)
    except ValidationError as exc:
        raise typer.BadParameter(str(exc), param_hint="--reasoning-effort") from exc


def _parse_headers(values: list[str] | None) -> dict[str, str] | None:
    headers: dict[str, str] = {}
    for raw in values or []:
        name, separator, value = raw.partition(":")
        if separator == "" or name.strip() == "":
            raise typer.BadParameter("Expected NAME: VALUE.", param_hint="--header")
        headers[name.strip()] = value.strip()
    return headers or None


def _make_config(
    *,
    model: str,
    synthesis_model: str | None,
    compaction_model: str | None,
    max_depth: int,
    max_turns: int,
    max_parallel: int,
    temperature: float | None,
    max_output_tokens: int | None,
    parallel_tool_calls: bool,
    reasoning_effort: ReasoningEffort | None,
    refusal_retries: int,
    base_url: str | None,
    api_key: str | None,
    default_headers: dict[str, str] | None,
    repo_path: Path | None,
) -> EngineConfig:
    def make_model_config(name: str, reasoning_effort: ReasoningEffort | None) -> ModelConfig:
        return ModelConfig(
            name=name,
            temperature=temperature,
            maximum_output_tokens=max_output_tokens,
            parallel_tool_calls=parallel_tool_calls,
            reasoning_effort=reasoning_effort,
        )

    root_model = make_model_config(model, reasoning_effort)
    subagent_model = make_model_config(model, reasoning_effort)
    synthesis = make_model_config(synthesis_model or model, None)
    compaction = make_model_config(compaction_model or model, None)

    root_agent = AgentConfig(
        name="root",
        model=root_model,
        maximum_turns=max_turns,
        refusal_retries=refusal_retries,
    )
    subagent = AgentConfig(
        name="sub",
        model=subagent_model,
        maximum_turns=max_turns,
        refusal_retries=refusal_retries,
    )

    return EngineConfig(
        root_agent=root_agent,
        subagent=subagent,
        synthesis_model=synthesis,
        compaction_model=compaction,
        model_provider=ModelProviderConfig(
            base_url=base_url,
            api_key=api_key,
            default_headers=default_headers,
        ),
        maximum_depth=max_depth,
        maximum_parallel_subagents=max_parallel,
        repo_path=repo_path,
    )


async def _stream(
    trace_path: Path, prompt: str, cfg: EngineConfig, *, telemetry: bool = False
) -> None:
    msgs = [AgentMessage(role="user", content=prompt)]
    async for ev in stream_engine_async(msgs, cfg, trace_path, telemetry=telemetry):
        if isinstance(ev, AgentTextDelta):
            console.print(ev.text_delta, end="", soft_wrap=True)
        elif isinstance(ev, AgentOutputItem):
            console.print()
            console.print(Rule(f"{ev.agent_name} (depth={ev.depth}, final={ev.final})"))
            console.print(ev.item)


def _require_api_key(api_key: str | None) -> None:
    if api_key is None and not os.environ.get("OPENAI_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        typer.echo(
            "No API key: pass --api-key or export OPENAI_API_KEY (or ANTHROPIC_API_KEY).",
            err=True,
        )
        raise typer.Exit(1)


def _require_ripgrep_for_repo(repo_path: Path | None) -> None:
    if repo_path is not None and find_ripgrep() is None:
        typer.echo(
            "--repo-path requires ripgrep (rg), which was not found on PATH. "
            "Install it (`brew install ripgrep`, `apt-get install ripgrep`, or "
            "`pip install ripgrep`) and re-run.",
            err=True,
        )
        raise typer.Exit(1)


cli = typer.Typer(add_completion=False, rich_markup_mode=None, no_args_is_help=True)


@cli.command("analyze")
def analyze(
    trace_path: Path = typer.Argument(
        ..., exists=True, readable=True, dir_okay=False, help="JSONL trace file."
    ),
    prompt: str = typer.Option(DEFAULT_PROMPT, "--prompt", "-p", help="Prompt for the root agent."),
    model: str = typer.Option("gpt-5.4-mini", "--model", "-m"),
    synthesis_model: str | None = typer.Option(None, "--synthesis-model"),
    compaction_model: str | None = typer.Option(None, "--compaction-model"),
    max_depth: int = typer.Option(2, "--max-depth", min=0),
    max_turns: int = typer.Option(20, "--max-turns", min=1),
    max_parallel: int = typer.Option(10, "--max-parallel", min=1),
    repo_path: Path | None = typer.Option(
        None, "--repo-path", exists=True, file_okay=False, dir_okay=True, readable=True, resolve_path=True,
        help="Local checkout of the source that produced the traces (enables read-only code/git tools).",
    ),
    base_url: str | None = typer.Option(None, "--base-url", help="OpenAI-compatible API base URL."),
    api_key: str | None = typer.Option(None, "--api-key", help="Provider API key."),
    headers: list[str] | None = typer.Option(None, "--header", "-H", help="Provider header NAME: VALUE."),
    temperature: float | None = typer.Option(None, "--temperature", min=0.0, max=2.0),
    max_output_tokens: int | None = typer.Option(None, "--max-output-tokens", min=1),
    parallel_tool_calls: bool = typer.Option(True, "--parallel-tool-calls/--no-parallel-tool-calls"),
    refusal_retries: int = typer.Option(0, "--refusal-retries", min=0),
    reasoning_effort: str | None = typer.Option(
        None, "--reasoning-effort",
        help=f"One of: {', '.join(REASONING_EFFORT_CHOICES)}. Omit for the model family default.",
    ),
    telemetry: bool = typer.Option(False, "--telemetry", help="Emit OpenInference traces of HALO itself."),
    detach: bool = typer.Option(False, "--detach", "-d", help="Run in the background as a detached job."),
) -> None:
    """Run the HALO engine against TRACE_PATH and stream output to stdout."""
    _require_api_key(api_key)
    _require_ripgrep_for_repo(repo_path)
    detach_if_requested(detach, name="analyze")
    cfg = _make_config(
        model=model,
        synthesis_model=synthesis_model,
        compaction_model=compaction_model,
        max_depth=max_depth,
        max_turns=max_turns,
        max_parallel=max_parallel,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        parallel_tool_calls=parallel_tool_calls,
        reasoning_effort=_parse_reasoning_effort(reasoning_effort),
        refusal_retries=refusal_retries,
        base_url=base_url,
        api_key=api_key,
        default_headers=_parse_headers(headers),
        repo_path=repo_path,
    )
    asyncio.run(_stream(trace_path, prompt, cfg, telemetry=telemetry))


@cli.command("pipeline")
def pipeline(
    project: str = typer.Argument(..., help="Langfuse project name (see .env for its keys)."),
    prompt: str = typer.Option(DEFAULT_PROMPT, "--prompt", "-p"),
    model: str = typer.Option(None, "--model", "-m", help="Defaults to $HALO_MODEL or claude-opus-4-8."),
    max_depth: int = typer.Option(None, "--max-depth", min=0),
    max_turns: int = typer.Option(None, "--max-turns", min=1),
    max_parallel: int = typer.Option(None, "--max-parallel", min=1),
    full: bool = typer.Option(False, "--full", help="Ignore the cursor and re-pull everything."),
    skip_backfill: bool = typer.Option(False, "--skip-backfill", help="Reuse the existing store file."),
    detach: bool = typer.Option(False, "--detach", "-d", help="Run the whole pipeline as a detached job."),
) -> None:
    """Backfill Langfuse -> convert -> analyze, in one command."""
    _require_api_key(None)
    detach_if_requested(detach, name=f"pipeline-{project}")

    store = Path.cwd() / "store"
    raw = store / f"{project}.jsonl"
    halo = store / f"{project}.halo.jsonl"

    if not skip_backfill:
        typer.echo(f"[1/3] backfill {project}")
        summary = backfill_project(project, limit=100, min_interval=0.25, max_pages=0, full=full)
        typer.echo(json.dumps(summary))
        if "skipped" in summary:
            raise typer.Exit(1)
    if not raw.exists():
        typer.echo(f"no store file at {raw}", err=True)
        raise typer.Exit(1)

    typer.echo("[2/3] convert -> HALO spans")
    conv = convert_traces(raw, halo, start=None, end=None, require_completed_traces=False)
    typer.echo(json.dumps(conv))

    typer.echo("[3/3] analyze")
    cfg = _make_config(
        model=model or os.environ.get("HALO_MODEL") or "claude-opus-4-8",
        synthesis_model=None,
        compaction_model=None,
        max_depth=max_depth if max_depth is not None else int(os.environ.get("HALO_MAX_DEPTH", 1)),
        max_turns=max_turns if max_turns is not None else int(os.environ.get("HALO_MAX_TURNS", 8)),
        max_parallel=max_parallel if max_parallel is not None else int(os.environ.get("HALO_MAX_PARALLEL", 2)),
        temperature=None,
        max_output_tokens=None,
        parallel_tool_calls=True,
        reasoning_effort=None,
        refusal_retries=0,
        base_url=os.environ.get("OPENAI_BASE_URL"),
        api_key=os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY"),
        default_headers=None,
        repo_path=None,
    )
    asyncio.run(_stream(halo, prompt, cfg))


cli.command("backfill")(backfill_command)
cli.command("convert")(convert_command)
cli.add_typer(jobs_app, name="jobs")


def app() -> None:
    """Entry point bound to `halo` in pyproject.toml."""
    load_dotenv()
    # Anthropic's OpenAI-compatible endpoint only serves /chat/completions, not
    # the Responses API the SDK defaults to. Flip the SDK when targeting it so
    # `--base-url https://api.anthropic.com/v1/ --model claude-opus-4-8` works
    # with a plain ANTHROPIC_API_KEY. Auto-on when the base URL is Anthropic.
    api_mode = os.environ.get("HALO_OPENAI_API")
    base = os.environ.get("OPENAI_BASE_URL", "")
    if api_mode == "chat_completions" or "anthropic.com" in base:
        from agents import set_default_openai_api

        set_default_openai_api("chat_completions")
    # Fall back to the Anthropic key for the OpenAI-compatible client.
    if not os.environ.get("OPENAI_API_KEY") and os.environ.get("ANTHROPIC_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ["ANTHROPIC_API_KEY"]
    cli()


if __name__ == "__main__":
    app()
