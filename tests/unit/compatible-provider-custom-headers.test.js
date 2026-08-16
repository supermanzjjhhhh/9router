import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext(nodeData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-headers-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/providers/route.js");
  const {
    createProviderNode,
    getProviderConnections,
    updateProviderNode,
  } = await import("@/models/index.js");

  const node = await createProviderNode(nodeData);

  return {
    node,
    POST,
    getProviderConnections,
    updateProviderNode,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("compatible provider customHeaders propagation & execution", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("propagates customHeaders from node to connection on creation", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-chat-cline-test",
      type: "openai-compatible",
      name: "Cline Test Node",
      prefix: "cline",
      apiType: "chat",
      baseUrl: "https://api.cline.bot/api/v1",
      customHeaders: { "x-client-type": "cline-cli" },
    });
    cleanup = ctx.cleanup;

    const req = new Request("https://9router.local/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: ctx.node.id,
        apiKey: "sk-test-cline",
        name: "Cline Conn",
        defaultModel: "deepseek/deepseek-v4-flash",
      }),
    });

    const res = await ctx.POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.connection.providerSpecificData.customHeaders).toEqual({
      "x-client-type": "cline-cli",
    });

    // Test DefaultExecutor & BaseExecutor buildHeaders
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const { BaseExecutor } = await import("open-sse/executors/base.js");

    const creds = {
      apiKey: "sk-test-cline",
      providerSpecificData: body.connection.providerSpecificData,
    };

    const defEx = new DefaultExecutor(ctx.node.id);
    const defHeaders = defEx.buildHeaders(creds, true);
    expect(defHeaders["x-client-type"]).toBe("cline-cli");
    expect(defHeaders["Authorization"]).toBe("Bearer sk-test-cline");

    const baseEx = new BaseExecutor(ctx.node.id, {});
    const baseHeaders = baseEx.buildHeaders(creds, true);
    expect(baseHeaders["x-client-type"]).toBe("cline-cli");
    expect(baseHeaders["Authorization"]).toBe("Bearer sk-test-cline");
  });
});
