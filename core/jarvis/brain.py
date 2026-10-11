from typing import Any, AsyncIterator, Literal

import openai

from . import approvals, config, tools

SYSTEM_PROMPT = f"""You are JARVIS, a personal AI assistant running on the user's own computer.

Address the user as "{config.USER_NAME}". Your manner is calm, capable and quietly witty, like a trusted aide who has worked with them for years.

Your replies are shown in a chat panel, so write the way you would speak: short, direct sentences, with the answer first. Use plain prose. Reach for a list or a code block only when the content truly is a list or code.

You can search the web for current information, open apps and websites on the user's computer, open a Google search in their browser, read the text of a public web page, type text into Notepad, and read the system status and time. When the user asks for one of these, do it with the matching tool and then confirm in a sentence what you did. Typing into Notepad shows the user an Allow or Deny prompt first; if they do not allow it, accept that and do not retry.

You cannot yet type or click in other apps or inside web pages, read or change files, or remember earlier sessions. If asked for something that needs those, say so plainly instead of pretending."""

# A reply may need several tool calls in a row; this stops a runaway loop.
MAX_TOOL_ROUNDS = 6

# ("text", delta) is a piece of the reply; ("tool", label) is an action just taken.
BrainEvent = tuple[Literal["text", "tool"], str]


class BrainError(Exception):
    """A failure the user should see as a plain message."""


class OpenAIBrain:
    def __init__(self) -> None:
        self._client: openai.AsyncOpenAI | None = None

    def _get_client(self) -> openai.AsyncOpenAI:
        if not config.OPENAI_API_KEY:
            raise BrainError("No API key found. Add OPENAI_API_KEY to .env and restart the core.")
        if self._client is None:
            self._client = openai.AsyncOpenAI(api_key=config.OPENAI_API_KEY)
        return self._client

    async def stream_reply(self, history: list[dict[str, Any]]) -> AsyncIterator[BrainEvent]:
        """Yield the next assistant turn as it happens and append its text to history."""
        client = self._get_client()
        parts: list[str] = []
        # The first request carries the conversation; follow-ups carry only tool
        # results and chain to the previous response.
        request: dict[str, Any] = {"input": history}
        try:
            for _ in range(MAX_TOOL_ROUNDS):
                stream = await client.responses.create(
                    model=config.MODEL,
                    instructions=SYSTEM_PROMPT,
                    tools=[{"type": "web_search"}, *tools.DEFINITIONS],
                    stream=True,
                    **request,
                )
                calls = []
                response_id = None
                async for event in stream:
                    if event.type == "response.output_text.delta":
                        parts.append(event.delta)
                        yield "text", event.delta
                    elif event.type == "response.output_item.done" and event.item.type == "function_call":
                        calls.append(event.item)
                    elif event.type == "response.completed":
                        response_id = event.response.id
                    elif event.type == "response.failed":
                        error = event.response.error
                        raise BrainError(error.message if error else "The model failed to produce a reply.")
                    elif event.type == "error":
                        raise BrainError(event.message)

                if not calls or response_id is None:
                    break
                outputs = []
                for call in calls:
                    result = await tools.execute(call.name, call.arguments, approvals.request)
                    yield "tool", result.label
                    outputs.append({"type": "function_call_output", "call_id": call.call_id, "output": result.output})
                request = {"input": outputs, "previous_response_id": response_id}
        except openai.AuthenticationError as e:
            raise BrainError("The OpenAI API key was rejected. Check OPENAI_API_KEY in .env.") from e
        except openai.RateLimitError as e:
            # OpenAI also reports an exhausted balance as a 429.
            raise BrainError(f"OpenAI refused the request: {e.message}") from e
        except openai.APIStatusError as e:
            raise BrainError(f"API error {e.status_code}: {e.message}") from e
        except openai.APIConnectionError as e:
            raise BrainError("Could not reach the OpenAI API. Check the internet connection.") from e

        history.append({"role": "assistant", "content": "".join(parts)})
