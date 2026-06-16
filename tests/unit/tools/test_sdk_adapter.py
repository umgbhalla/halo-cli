from __future__ import annotations

from agents import RunContextWrapper
from pydantic import BaseModel

from engine.tools.tool_protocol import ToolContext, to_sdk_function_tool


class _Args(BaseModel):
    value: str


class _Result(BaseModel):
    echoed: str


class _Echo:
    name = "echo"
    description = "Echo a value."
    arguments_model = _Args
    result_model = _Result

    async def run(self, tool_context: ToolContext, arguments: _Args) -> _Result:
        return _Result(echoed=arguments.value)


class _Boom:
    name = "boom"
    description = "Always raises."
    arguments_model = _Args
    result_model = _Result

    async def run(self, tool_context: ToolContext, arguments: _Args) -> _Result:
        raise ValueError("not a file: 'src/agent/config.py'")


def test_adapter_produces_sdk_function_tool() -> None:
    from agents import FunctionTool

    sdk_tool = to_sdk_function_tool(
        _Echo(), context_factory=lambda ctx: ToolContext.model_construct()
    )
    assert isinstance(sdk_tool, FunctionTool)
    assert sdk_tool.name == "echo"
    assert "Echo" in (sdk_tool.description or "")


async def test_adapter_invokes_tool_and_serializes_result() -> None:
    sdk_tool = to_sdk_function_tool(
        _Echo(), context_factory=lambda ctx: ToolContext.model_construct()
    )
    output = await sdk_tool.on_invoke_tool(RunContextWrapper(context=None), '{"value": "hi"}')
    assert output == '{"echoed":"hi"}'


async def test_adapter_returns_tool_error_to_model_instead_of_raising() -> None:
    sdk_tool = to_sdk_function_tool(
        _Boom(), context_factory=lambda ctx: ToolContext.model_construct()
    )
    output = await sdk_tool.on_invoke_tool(RunContextWrapper(context=None), '{"value": "x"}')
    assert output == (
        "An error occurred while running the tool. Please try again. "
        "Error: not a file: 'src/agent/config.py'"
    )
