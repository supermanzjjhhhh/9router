import { describe, it, expect, vi, beforeEach } from "vitest";
import freebuffRegistry from "open-sse/providers/registry/freebuff.js";
import freebuffOAuth from "@/lib/oauth/providers/freebuff.js";
import { FreebuffExecutor } from "open-sse/executors/freebuff.js";
import { getExecutor } from "open-sse/executors/index.js";

describe("freebuff provider registration", () => {
  it("exports correct provider metadata", () => {
    expect(freebuffRegistry.id).toBe("freebuff");
    expect(freebuffRegistry.category).toBe("freeTier");
    expect(freebuffRegistry.hasOAuth).toBe(true);
    expect(freebuffRegistry.authModes).toEqual(["oauth", "apikey"]);
    expect(freebuffRegistry.transport.baseUrl).toBe("https://www.codebuff.com/api/v1/chat/completions");
    expect(freebuffRegistry.models.length).toBeGreaterThan(0);
  });

  it("resolves FreebuffExecutor from executor registry", () => {
    const executor = getExecutor("freebuff");
    expect(executor).toBeInstanceOf(FreebuffExecutor);
  });
});

describe("freebuff oauth flow", () => {
  it("requests device code with proper fingerprint format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        loginUrl: "https://www.codebuff.com/login?auth_code=test1234",
        fingerprintHash: "hash-test-1234",
        expiresAt: Date.now() + 3600000,
        expiresInMs: 3600000,
      }),
    });
    global.fetch = mockFetch;

    const data = await freebuffOAuth.requestDeviceCode({
      initiateUrl: "https://www.codebuff.com/api/auth/cli/code",
      pollInterval: 5000,
    });

    expect(data.verification_uri).toBe("https://www.codebuff.com/login?auth_code=test1234");
    expect(data._fingerprintId).toMatch(/^codebuff-cli-[a-zA-Z0-9_-]{8}$/);
    expect(data._fingerprintHash).toBe("hash-test-1234");
  });

  it("handles 401 polling status as authorization_pending", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
    });
    global.fetch = mockFetch;

    const result = await freebuffOAuth.pollToken(
      { pollUrlBase: "https://www.codebuff.com/api/auth/cli/status" },
      "codebuff-cli-12345678",
      null,
      {
        _fingerprintId: "codebuff-cli-12345678",
        _fingerprintHash: "hash-test",
        _expiresAt: Date.now() + 3600000,
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data.error).toBe("authorization_pending");
  });

  it("handles successful token exchange and maps tokens", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        user: {
          id: "usr_12345",
          email: "test@example.com",
          authToken: "fb_tok_secret_987",
          credits: 100,
        },
      }),
    });
    global.fetch = mockFetch;

    const result = await freebuffOAuth.pollToken(
      { pollUrlBase: "https://www.codebuff.com/api/auth/cli/status" },
      "codebuff-cli-12345678",
      null,
      {
        _fingerprintId: "codebuff-cli-12345678",
        _fingerprintHash: "hash-test",
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe("fb_tok_secret_987");

    const mapped = freebuffOAuth.mapTokens(result.data);
    expect(mapped.accessToken).toBe("fb_tok_secret_987");
    expect(mapped.email).toBe("test@example.com");
    expect(mapped.providerSpecificData.userId).toBe("usr_12345");
  });
});

describe("freebuff executor request transformation", () => {
  it("injects canonical Buffy marker and metadata", () => {
    const executor = new FreebuffExecutor();
    const body = {
      model: "freebuff/mimo/mimo-v2.5",
      messages: [{ role: "user", content: "hello" }],
    };
    const session = { instanceId: "inst_test_123" };
    const runId = "run_test_456";

    const transformed = executor.transformRequest(
      "freebuff/mimo/mimo-v2.5",
      body,
      true,
      { apiKey: "fb_test_token" },
      session,
      runId
    );

    expect(transformed.model).toBe("mimo/mimo-v2.5");
    expect(transformed.messages[0].role).toBe("system");
    expect(transformed.messages[0].content).toContain("You are Buffy, the strategic coding assistant.");
    expect(transformed.codebuff_metadata.freebuff_instance_id).toBe("inst_test_123");
    expect(transformed.codebuff_metadata.run_id).toBe("run_test_456");
    expect(transformed.codebuff_metadata.cost_mode).toBe("free");
  });
});
