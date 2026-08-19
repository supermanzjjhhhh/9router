import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-routing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createProviderNode } = await import("@/models/index.js");
  const { getModelInfo } = await import("@/sse/services/model.js");

  return {
    createProviderNode,
    getModelInfo,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("model routing", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps built-in provider aliases ahead of compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible CF Collision",
      prefix: "cf",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("cf/@cf/black-forest-labs/flux-2-klein-9b"))
      .resolves.toEqual({
        provider: "cloudflare-ai",
        model: "@cf/black-forest-labs/flux-2-klein-9b",
      });
  });

  it("still routes non-reserved compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible OCT",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("oct/gpt-image-1"))
      .resolves.toEqual({
        provider: "openai-compatible-chat-test",
        model: "gpt-image-1",
      });
  });

  it("routes bare model ids to a single empty-prefix openai-compatible relay", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-relay",
      type: "openai-compatible",
      name: "NewAPI Relay",
      prefix: "",
      apiType: "chat",
      baseUrl: "https://new-api.example/v1",
    });

    await expect(ctx.getModelInfo("gpt-4o")).resolves.toEqual({
      provider: "openai-compatible-chat-relay",
      model: "gpt-4o",
    });

    // Must beat inferProviderFromModelName(claude-* → anthropic)
    await expect(ctx.getModelInfo("claude-sonnet-4")).resolves.toEqual({
      provider: "openai-compatible-chat-relay",
      model: "claude-sonnet-4",
    });
  });

  it("routes bare model ids to a single empty-prefix anthropic-compatible relay", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "anthropic-compatible-relay",
      type: "anthropic-compatible",
      name: "Sub2API Anthropic",
      prefix: "",
      baseUrl: "https://sub2api.example/v1",
    });

    await expect(ctx.getModelInfo("claude-opus-4")).resolves.toEqual({
      provider: "anthropic-compatible-relay",
      model: "claude-opus-4",
    });
  });

  it("keeps non-empty compatible prefixes working alongside empty-prefix relays", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-relay",
      type: "openai-compatible",
      name: "Relay",
      prefix: "",
      apiType: "chat",
      baseUrl: "https://relay.example/v1",
    });
    await ctx.createProviderNode({
      id: "openai-compatible-chat-pref",
      type: "openai-compatible",
      name: "Prefixed",
      prefix: "newapi",
      apiType: "chat",
      baseUrl: "https://new-api.example/v1",
    });

    await expect(ctx.getModelInfo("newapi/deepseek-chat")).resolves.toEqual({
      provider: "openai-compatible-chat-pref",
      model: "deepseek-chat",
    });
    await expect(ctx.getModelInfo("deepseek-chat")).resolves.toEqual({
      provider: "openai-compatible-chat-relay",
      model: "deepseek-chat",
    });
  });

  it("routes slash-containing bare model ids through empty-prefix relay", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-relay",
      type: "openai-compatible",
      name: "Relay",
      prefix: "",
      apiType: "chat",
      baseUrl: "https://relay.example/v1",
    });

    await expect(ctx.getModelInfo("moonshotai/Kimi-K2.5")).resolves.toEqual({
      provider: "openai-compatible-chat-relay",
      model: "moonshotai/Kimi-K2.5",
    });
  });

  it("prefers anthropic empty-prefix node for claude bare models when both types exist", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-relay",
      type: "openai-compatible",
      name: "OpenAI Relay",
      prefix: "",
      apiType: "chat",
      baseUrl: "https://openai-relay.example/v1",
    });
    await ctx.createProviderNode({
      id: "anthropic-compatible-relay",
      type: "anthropic-compatible",
      name: "Anthropic Relay",
      prefix: "",
      baseUrl: "https://anthropic-relay.example/v1",
    });

    await expect(ctx.getModelInfo("claude-sonnet-4")).resolves.toEqual({
      provider: "anthropic-compatible-relay",
      model: "claude-sonnet-4",
    });
    await expect(ctx.getModelInfo("gpt-4o")).resolves.toEqual({
      provider: "openai-compatible-chat-relay",
      model: "gpt-4o",
    });
  });

});
