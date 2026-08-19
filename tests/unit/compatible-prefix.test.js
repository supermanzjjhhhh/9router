import { describe, it, expect } from "vitest";
import {
  normalizeCompatiblePrefix,
  isEmptyCompatiblePrefix,
  formatCompatibleModelRef,
  resolveCompatibleOutputAlias,
  findEmptyPrefixConflict,
} from "@/shared/utils/compatiblePrefix.js";

describe("compatiblePrefix helpers", () => {
  it("normalizes whitespace-only prefix to empty", () => {
    expect(normalizeCompatiblePrefix("  ")).toBe("");
    expect(normalizeCompatiblePrefix(null)).toBe("");
    expect(normalizeCompatiblePrefix(" oc-prod ")).toBe("oc-prod");
    expect(isEmptyCompatiblePrefix("")).toBe(true);
    expect(isEmptyCompatiblePrefix("  ")).toBe(true);
    expect(isEmptyCompatiblePrefix("newapi")).toBe(false);
  });

  it("formats model refs with optional prefix", () => {
    expect(formatCompatibleModelRef("oc-prod", "gpt-4o")).toBe("oc-prod/gpt-4o");
    expect(formatCompatibleModelRef("", "claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(formatCompatibleModelRef("  ", "gpt-4o")).toBe("gpt-4o");
    expect(formatCompatibleModelRef("newapi", "moonshotai/Kimi-K2.5")).toBe("newapi/moonshotai/Kimi-K2.5");
  });

  it("preserves empty output alias instead of falling back", () => {
    expect(resolveCompatibleOutputAlias("", "fallback-id")).toBe("");
    expect(resolveCompatibleOutputAlias(undefined, "fallback-id")).toBe("fallback-id");
    expect(resolveCompatibleOutputAlias(null, "fallback-id")).toBe("fallback-id");
    expect(resolveCompatibleOutputAlias(" ac ", "fallback-id")).toBe("ac");
  });

  it("detects empty-prefix conflicts per type", () => {
    const nodes = [
      { id: "a", type: "openai-compatible", prefix: "", name: "relay-a" },
      { id: "b", type: "openai-compatible", prefix: "oc", name: "oc" },
      { id: "c", type: "anthropic-compatible", prefix: "", name: "relay-c" },
    ];
    expect(findEmptyPrefixConflict(nodes, { type: "openai-compatible" })?.id).toBe("a");
    expect(findEmptyPrefixConflict(nodes, { type: "openai-compatible", excludeId: "a" })).toBeNull();
    expect(findEmptyPrefixConflict(nodes, { type: "anthropic-compatible" })?.id).toBe("c");
    expect(findEmptyPrefixConflict(nodes, { type: "custom-embedding" })).toBeNull();
  });
});
