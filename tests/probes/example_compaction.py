"""Probe: AgentContext.compact_old_items behavior.

Pathways probed (unit-style, against AgentContext directly — no FakeRunner
needed for the core logic):

  1. Compaction of an empty/small context is a no-op (no compactor calls).
  2. System messages are NEVER compacted, even when they are old.
  3. Text messages and tool-related messages have separate eligibility caps.
  4. Compacted items render through ``to_messages_array`` with the role-specific
     summary template — and crucially, a plain-text assistant message
     (NOT a tool-call) should not be rendered as "Compacted tool calls".

Why this matters: ``_render_item`` (engine/agents/agent_context.py)
renders ANY compacted assistant as "Compacted tool calls (id: ..., ...)",
but a plain-text assistant message is classified as a TEXT message
(``_is_tool_related`` returns False for assistants without tool_calls), so
it lands in ``text_positions`` and can absolutely be compacted as a text
overflow. The label is wrong in that case.

Testing technique: ``compact_old_items`` now takes an ``AsyncOpenAI``
directly and calls the module-level ``compact()`` function. Probes
inject a duck-typed ``_FakeAsyncOpenAI`` whose ``chat.completions.create``
returns a fixed marker, and assert against observable post-state
(``ctx.items[i].is_compacted``) rather than recorded callable calls.
"""

from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace
from typing import Any

from engine.agents.agent_context import AgentContext
from engine.agents.agent_context_items import AgentContextItem
from engine.model_config import ModelConfig
from engine.models.messages import AgentToolCall, AgentToolFunction

_FAILURES: list[str] = []


def _check(condition: bool, description: str, observed: str = "") -> None:
    if condition:
        print(f"PASS: {description}")
    else:
        suffix = f" — observed: {observed}" if observed else ""
        print(f"FAIL: {description}{suffix}")
        _FAILURES.append(description)


class _FakeCompletions:
    """Duck-typed stand-in for ``AsyncOpenAI().chat.completions``.

    Declares the keyword-only params ``compact()`` actually forwards so a
    signature change in ``engine.agents.compactor.compact`` breaks visibly
    instead of being absorbed by a catchall.
    """

    async def create(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: Any,
    ) -> Any:
        del model, messages, temperature
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="SUMMARY"))]
        )


class _FakeAsyncOpenAI:
    """Duck-typed stand-in for ``AsyncOpenAI``: serves ``compact()`` a
    deterministic completion without a real network/key.
    """

    def __init__(self) -> None:
        self.chat = SimpleNamespace(completions=_FakeCompletions())


def _compacted_ids(ctx: AgentContext) -> set[str]:
    """Observable post-state: which item_ids ended up compacted."""
    return {it.item_id for it in ctx.items if it.is_compacted}


def _make_ctx(
    items: list[AgentContextItem], *, keep_text: int = 2, keep_tool: int = 2
) -> AgentContext:
    return AgentContext(
        items=items,
        compaction_model=ModelConfig(name="gpt-5.4-mini"),
        text_message_compaction_keep_last_messages=keep_text,
        tool_call_compaction_keep_last_turns=keep_tool,
    )


async def probe_no_op_when_under_thresholds() -> None:
    """No items above the keep_last cap means no compaction happens."""
    items = [
        AgentContextItem(item_id="sys-0", role="system", content="sys"),
        AgentContextItem(item_id="u-0", role="user", content="hi"),
    ]
    ctx = _make_ctx(items, keep_text=2, keep_tool=2)
    await ctx.compact_old_items(_FakeAsyncOpenAI())  # type: ignore[arg-type]

    _check(
        _compacted_ids(ctx) == set(),
        "noop: no items compacted when under threshold",
        observed=f"compacted={sorted(_compacted_ids(ctx))}",
    )
    _check(all(not it.is_compacted for it in ctx.items), "noop: no items marked is_compacted")


async def probe_system_never_compacted() -> None:
    """Even with the system message in position 0 of a long history, it must
    never be compacted."""
    items = [
        AgentContextItem(item_id="sys-0", role="system", content="sys"),
        # 5 user messages; with keep_text=1 → 4 oldest user msgs eligible
        *[AgentContextItem(item_id=f"u-{i}", role="user", content=f"msg{i}") for i in range(5)],
    ]
    ctx = _make_ctx(items, keep_text=1, keep_tool=2)
    await ctx.compact_old_items(_FakeAsyncOpenAI())  # type: ignore[arg-type]

    sys_item = ctx.items[0]
    _check(
        sys_item.role == "system" and not sys_item.is_compacted,
        "sys-immune: system message NOT compacted",
        observed=f"is_compacted={sys_item.is_compacted}",
    )
    _check(
        all(it.role != "system" for it in ctx.items if it.is_compacted),
        "sys-immune: no compacted item has role=system",
        observed=f"compacted_roles={[it.role for it in ctx.items if it.is_compacted]}",
    )


async def probe_text_vs_tool_split() -> None:
    """Text and tool eligibility caps are independent. With keep_text=1 and
    keep_tool=2 (turns), given 3 text turns and 3 tool turns: 2 oldest texts
    plus the 1 oldest tool turn (assistant + result, both items) eligible."""
    tc0 = AgentToolCall(id="c0", function=AgentToolFunction(name="foo", arguments="{}"))
    tc1 = AgentToolCall(id="c1", function=AgentToolFunction(name="foo", arguments="{}"))
    tc2 = AgentToolCall(id="c2", function=AgentToolFunction(name="foo", arguments="{}"))
    items = [
        AgentContextItem(item_id="sys-0", role="system", content="sys"),
        AgentContextItem(item_id="u-0", role="user", content="t1"),
        AgentContextItem(item_id="u-1", role="user", content="t2"),
        AgentContextItem(item_id="u-2", role="user", content="t3"),
        AgentContextItem(item_id="a-0", role="assistant", tool_calls=[tc0]),
        AgentContextItem(item_id="tr-0", role="tool", content="r1", tool_call_id="c0", name="foo"),
        AgentContextItem(item_id="a-1", role="assistant", tool_calls=[tc1]),
        AgentContextItem(item_id="tr-1", role="tool", content="r2", tool_call_id="c1", name="foo"),
        AgentContextItem(item_id="a-2", role="assistant", tool_calls=[tc2]),
        AgentContextItem(item_id="tr-2", role="tool", content="r3", tool_call_id="c2", name="foo"),
    ]
    ctx = _make_ctx(items, keep_text=1, keep_tool=2)
    await ctx.compact_old_items(_FakeAsyncOpenAI())  # type: ignore[arg-type]

    _check(
        _compacted_ids(ctx) == {"u-0", "u-1", "a-0", "tr-0"},
        "split: 2 oldest texts + the 1 oldest tool turn (asst + result) compacted",
        observed=f"compacted_ids={sorted(_compacted_ids(ctx))}",
    )


async def probe_assistant_text_compacted_label_mismatch() -> None:
    """A plain-text assistant message (no tool_calls) is classified as TEXT.
    When it overflows the text cap and gets compacted, ``_render_item`` (in
    AgentContext.to_messages_array) renders it with the label
    'Compacted tool calls' — which is wrong, because the original was a
    plain assistant text message, not a tool call. This probe catches that
    mislabel.
    """
    items = [
        AgentContextItem(item_id="sys-0", role="system", content="sys"),
        # 4 plain assistant text messages (no tool_calls), keep_text=1.
        *[
            AgentContextItem(item_id=f"a-{i}", role="assistant", content=f"hi {i}")
            for i in range(4)
        ],
    ]
    ctx = _make_ctx(items, keep_text=1, keep_tool=2)
    await ctx.compact_old_items(_FakeAsyncOpenAI())  # type: ignore[arg-type]

    # First 3 assistants should be eligible (4 - 1 keep = 3 cutoff).
    _check(
        _compacted_ids(ctx) == {"a-0", "a-1", "a-2"},
        "asst-text: 3 oldest plain-text assistants compacted",
        observed=f"compacted={sorted(_compacted_ids(ctx))}",
    )

    rendered = ctx.to_messages_array()
    # The compacted assistant items should render with content describing
    # an assistant TEXT message — not 'Compacted tool calls'.
    rendered_a0 = next(
        (m for m in rendered if isinstance(m.content, str) and "a-0" in m.content), None
    )
    _check(rendered_a0 is not None, "asst-text: compacted a-0 appears in rendered output")
    if rendered_a0 is not None:
        _check(
            "Compacted tool calls" not in (rendered_a0.content or ""),
            "asst-text: render label does NOT say 'Compacted tool calls' for plain-text assistant",
            observed=f"content={rendered_a0.content!r}",
        )


async def probe_assistant_with_tool_calls_renders_tool_calls_label() -> None:
    """Sanity check the contrapositive: a true tool-call assistant, when
    compacted, *should* render with 'Compacted tool calls' label."""
    tc = AgentToolCall(id="c0", function=AgentToolFunction(name="foo", arguments="{}"))
    items = [
        AgentContextItem(item_id="sys-0", role="system", content="sys"),
        # 3 tool-call assistants + 3 tool results; keep_tool=1 → 5 eligible
        AgentContextItem(item_id="a-0", role="assistant", tool_calls=[tc]),
        AgentContextItem(item_id="tr-0", role="tool", content="r0", tool_call_id="c0", name="foo"),
        AgentContextItem(item_id="a-1", role="assistant", tool_calls=[tc]),
        AgentContextItem(item_id="tr-1", role="tool", content="r1", tool_call_id="c0", name="foo"),
        AgentContextItem(item_id="a-2", role="assistant", tool_calls=[tc]),
        AgentContextItem(item_id="tr-2", role="tool", content="r2", tool_call_id="c0", name="foo"),
    ]
    ctx = _make_ctx(items, keep_text=1, keep_tool=1)
    await ctx.compact_old_items(_FakeAsyncOpenAI())  # type: ignore[arg-type]

    rendered = ctx.to_messages_array()
    a0 = rendered[1]  # corresponds to a-0
    _check(
        a0.role == "assistant" and "Compacted tool calls" in (a0.content or ""),
        "asst-toolcall: tool-call assistant compacts as 'Compacted tool calls'",
        observed=f"a0_content={a0.content!r}",
    )


async def probe_parallel_tool_calls_compact_as_a_unit() -> None:
    """Parallel tool calls land as separate assistant messages each with one
    tool_call, followed by their tool results: ``[a-0(c0), a-1(c1), t-0, t-1]``.
    Group-aware eligibility forms two tool turns ({a-0,t-0}, {a-1,t-1}) and
    compacts them as units — so a-0 and t-0 either both compact together, or
    neither does. Either way the rendered messages array stays coherent
    (every role=tool has a preceding assistant.tool_calls match)."""
    tc0 = AgentToolCall(id="c0", function=AgentToolFunction(name="foo", arguments="{}"))
    tc1 = AgentToolCall(id="c1", function=AgentToolFunction(name="foo", arguments="{}"))
    items = [
        AgentContextItem(item_id="sys-0", role="system", content="sys"),
        AgentContextItem(item_id="u-0", role="user", content="kick off"),
        AgentContextItem(item_id="a-0", role="assistant", tool_calls=[tc0]),
        AgentContextItem(item_id="a-1", role="assistant", tool_calls=[tc1]),
        AgentContextItem(item_id="t-0", role="tool", content="r0", tool_call_id="c0", name="foo"),
        AgentContextItem(item_id="t-1", role="tool", content="r1", tool_call_id="c1", name="foo"),
    ]
    ctx = _make_ctx(items, keep_text=10, keep_tool=1)
    await ctx.compact_old_items(_FakeAsyncOpenAI())  # type: ignore[arg-type]

    _check(
        _compacted_ids(ctx) == {"a-0", "t-0"},
        "parallel: oldest tool turn (a-0 + its result t-0) compacted as a unit",
        observed=f"compacted_ids={sorted(_compacted_ids(ctx))}",
    )


async def main() -> int:
    await probe_no_op_when_under_thresholds()
    await probe_system_never_compacted()
    await probe_text_vs_tool_split()
    await probe_assistant_text_compacted_label_mismatch()
    await probe_assistant_with_tool_calls_renders_tool_calls_label()
    await probe_parallel_tool_calls_compact_as_a_unit()

    if _FAILURES:
        print(f"\n{len(_FAILURES)} check(s) failed:")
        for desc in _FAILURES:
            print(f"  - {desc}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
