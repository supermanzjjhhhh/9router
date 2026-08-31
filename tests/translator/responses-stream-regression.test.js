import { describe, expect, it } from "vitest";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";

async function runTransform(chunks) {
  const input = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  const encoder = new TextEncoder();
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

describe("Responses stream reasoning regression", () => {
  it("does not expose upstream reasoning or reuse its output index for the answer", async () => {
    const output = await runTransform([
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { reasoning_content: "private reasoning" } }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "visible answer" } }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    expect(output).not.toContain("private reasoning");
    expect(output).not.toContain("response.reasoning_summary");

    const added = [...output.matchAll(/event: response\.output_item\.added\ndata: (.+)\n/g)]
      .map((match) => JSON.parse(match[1]));
    expect(added).toHaveLength(1);
    expect(added[0].output_index).toBe(0);
    expect(added[0].item.type).toBe("message");
  });

  it("does not expose upstream reasoning in non-streaming Responses JSON", () => {
    const response = translateNonStreamingResponse({
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

    expect(JSON.stringify(response)).not.toContain("private reasoning");
    expect(response.output.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("does not expose upstream reasoning through the production translator path", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: { reasoning_content: "private reasoning" } }],
    }, state);

    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(events.some((event) => event.event?.startsWith("response.reasoning_summary"))).toBe(false);
  });
});
