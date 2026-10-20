// Run explicitly: QODER_TEST_CONTAINER=<candidate> node --test this-file.cjs
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const container = process.env.QODER_TEST_CONTAINER;

// Exercise the shipped executor, not a copy of its context-selection logic.
// Only the remote model catalog and final HTTP transport are substituted.
function requestFor(contextConfig, preference = "1M") {
  const script = String.raw`
(async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const base = "/app/.next-cli-build/server/";
  const runtime = require(base + "webpack-runtime.js");
  const chunks = new Set();
  process.env.QODER_CONTEXT_TIER = ${JSON.stringify(preference)};
  globalThis.fetch = async (url) => {
    if (String(url).includes("/model/list")) {
      return Response.json({ chat: [{
        key: "dfmodel", enable: true, source: "system",
        max_input_tokens: 180000, context_config: ${JSON.stringify(contextConfig)},
      }] });
    }
    if (String(url).includes("agent_chat_generation")) {
      return new Response("captured", { status: 418 });
    }
    throw new Error("Unexpected upstream URL");
  };
  for (const path of ["app/api/providers/[id]/models/route.js", "app/api/v1/chat/completions/route.js"]) {
    vm.runInNewContext(fs.readFileSync(base + path, "utf8"), {
      module: { exports: {} }, exports: {},
      require(name) {
        if (name.endsWith("webpack-runtime.js")) {
          return { C(chunk) { runtime.C(chunk); }, X(_, ids) { ids.forEach(id => chunks.add(id)); return {}; } };
        }
        return require(name);
      },
    });
  }
  for (const id of chunks) await runtime.e(id);
  const Executor = runtime(56411).DH;
  const result = await new Executor("qoder-cn").execute({
    model: "dfmodel", stream: true,
    body: { messages: [{ role: "user", content: "OK" }], max_tokens: 32 },
    credentials: { provider: "qoder-cn", accessToken: "test-token", providerSpecificData: { userId: "test-user" } },
    signal: AbortSignal.timeout(10000),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await result.response.text();
  const body = result.transformedBody;
  console.log(JSON.stringify({
    status: result.response.status,
    maxInput: body.model_config?.max_input_tokens ?? null,
    contextLength: body.parameters?.context_length ?? null,
    ideOverride: body.chat_context?.extra?.ideModelConfigOverride?.max_input_tokens ?? null,
  }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });`;
  return JSON.parse(execFileSync("docker", ["exec", "-i", container, "node", "--max-old-space-size=192", "-"], {
    input: script, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  }));
}

describe("Qoder context selection in the deployed npm artifact", { skip: !container }, () => {
  it("selects 1M from the Qoder CN object catalog", () => {
    const result = requestFor({
      "1M": { token_count: 1000000 },
      "200K": { token_count: 200000, is_default: true },
      "400K": { token_count: 400000 },
    });
    assert.deepEqual(result, { status: 418, maxInput: 1000000, contextLength: 1000000, ideOverride: 1000000 });
  });
  it("keeps the legacy array catalog working", () => {
    const result = requestFor([
      { name: "200K", tokenCount: 200000, isDefault: true },
      { name: "1M", tokenCount: 1000000 },
    ]);
    assert.deepEqual(result, { status: 418, maxInput: 1000000, contextLength: 1000000, ideOverride: 1000000 });
  });

  it("ignores invalid named entries without hiding a valid tier", () => {
    const result = requestFor({ invalid: null, text: "bad", list: [], "1M": { token_count: 1000000 } });
    assert.deepEqual(result, { status: 418, maxInput: 1000000, contextLength: 1000000, ideOverride: 1000000 });
  });

  it("preserves the existing default-tier selection", () => {
    const result = requestFor({
      "1M": { token_count: 1000000 }, "200K": { token_count: 200000, is_default: true },
    }, "default");
    assert.deepEqual(result, { status: 418, maxInput: 200000, contextLength: 200000, ideOverride: 200000 });
  });

  it("preserves auto mode for a small prompt", () => {
    const result = requestFor({ "1M": { token_count: 1000000 }, "200K": { token_count: 200000, is_default: true } }, "auto");
    assert.deepEqual(result, { status: 418, maxInput: 180000, contextLength: null, ideOverride: null });
  });

  for (const [name, config] of [
    ["missing", undefined], ["null", null], ["string", "1M"], ["empty", {}],
    ["invalid token limits", { "1M": { token_count: "Infinity" }, negative: { token_count: -1 }, zero: { token_count: 0 } }],
  ]) {
    it(`does not invent unsupported tiers for ${name} configuration`, () => {
      assert.deepEqual(requestFor(config), { status: 418, maxInput: 180000, contextLength: null, ideOverride: null });
    });
  }

});
