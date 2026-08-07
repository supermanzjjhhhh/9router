import { describe, expect, it } from "vitest";
import "./registerAll.js";

import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";

async function runResponsesTransform(chunks) {
  const encoder = new TextEncoder();
  const input = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const reader = stream.pipeThrough(createResponsesApiTransformStream()).getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  return output + decoder.decode();
}

describe("Responses API hides upstream raw reasoning", () => {
  it("does not expose Chat Completions reasoning_content as a Codex reasoning summary", async () => {
    const output = await runResponsesTransform([
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { reasoning_content: "private reasoning" } }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "visible answer" } }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "shell", arguments: '{"cmd":"pwd"}' } }] } }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);

    expect(output).toContain("response.output_text.delta");
    expect(output).toContain("visible answer");
    expect(output).toContain("response.function_call_arguments.delta");
    expect(output).toContain("shell");
    expect(output).not.toContain("private reasoning");
    expect(output).not.toContain("response.reasoning_summary");
  });

  it("strips think tags without dropping the following answer", async () => {
    const output = await runResponsesTransform([
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "<think>private thought</think>visible answer" } }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    expect(output).toContain("visible answer");
    expect(output).not.toContain("private thought");
    expect(output).not.toContain("response.reasoning_summary");
  });

  it("does not expose Antigravity thought parts through the translator path", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI_RESPONSES, {
      responseId: "resp-test",
      modelVersion: "gemini-test",
      candidates: [{
        content: {
          parts: [
            { text: "private thought", thought: true },
            { text: "visible answer" },
          ],
        },
        finishReason: "STOP",
      }],
    }, state);
    const output = JSON.stringify(events);

    expect(output).toContain("response.output_text.delta");
    expect(output).toContain("visible answer");
    expect(output).not.toContain("private thought");
    expect(output).not.toContain("response.reasoning_summary");
  });

  it("does not expose non-streaming reasoning_content as a Responses output item", () => {
    const output = translateNonStreamingResponse({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_content: "private reasoning",
        },
        finish_reason: "stop",
      }],
    }, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const serialized = JSON.stringify(output);

    expect(serialized).toContain("visible answer");
    expect(serialized).not.toContain("private reasoning");
    expect(output.output.some((item) => item.type === "reasoning")).toBe(false);
  });
});
