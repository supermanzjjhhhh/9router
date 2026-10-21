import { describe, expect, it } from "vitest";
import { aggregateComboCapabilities, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import qoderCnRegistry from "../../open-sse/providers/registry/qoder-cn.js";
import qoderRegistry from "../../open-sse/providers/registry/qoder.js";

// Qoder's upstream ids are opaque (`dfmodel`, `qmodel_38max`, …), so the
// capability table is the ONLY source of a real context window: the live
// catalog resolver returns just { id, name }, and the pattern fallback in
// capabilities.js matches on the canonical model name, not the opaque id.
//
// Commit 5c217d34 deleted the provider table but left the alias line
// `PROVIDER_CAPABILITIES["qoder-cn"] = PROVIDER_CAPABILITIES["qoder"]` behind.
// Both sides became undefined, so every Qoder CN model silently resolved to
// DEFAULT_CAPABILITIES (200K), and combos that min-aggregate member windows
// (e.g. my-domestic = qdcn/dfmodel + cbcn/deepseek-v4.1-flash) inherited 200K
// even though the model itself accepts 1M.

const EXPECTED = {
  ultimate: { contextWindow: 1_000_000, maxOutput: 128_000, vision: true },
  performance: { contextWindow: 1_000_000, maxOutput: 128_000, vision: true },
  dmodel: { contextWindow: 1_000_000, maxOutput: 65_536 },
  dfmodel: { contextWindow: 1_000_000, maxOutput: 65_536 },
  gmodel: { contextWindow: 1_000_000, maxOutput: 128_000 },
  gfmodel: { contextWindow: 1_000_000, maxOutput: 128_000, vision: true },
  kmodel_latest: { contextWindow: 1_000_000, maxOutput: 65_536, vision: true },
  kmodel: { contextWindow: 256_000, maxOutput: 65_536, vision: true },
  mmodel: { contextWindow: 1_000_000, maxOutput: 512_000 },
  qmodel_latest: { contextWindow: 1_000_000, maxOutput: 65_536, vision: true },
  qmodel: { contextWindow: 1_000_000, maxOutput: 65_536, vision: true },
  qfmodel: { contextWindow: 1_000_000, maxOutput: 65_536, vision: true },
  qmodel_38max: { contextWindow: 1_000_000, maxOutput: 65_536, vision: true },
};

describe("Qoder capability tables", () => {
  it("resolves Qoder CN opaque model ids to their real family windows", () => {
    for (const [model, expected] of Object.entries(EXPECTED)) {
      expect(getCapabilitiesForModel("qoder-cn", model), model).toMatchObject(expected);
    }
  });

  it("keeps Qoder CN and intl on the same catalog (alias is not dangling)", () => {
    for (const model of Object.keys(EXPECTED)) {
      expect(getCapabilitiesForModel("qoder-cn", model), model).toEqual(
        getCapabilitiesForModel("qoder", model)
      );
    }
  });

  it("covers every model the Qoder CN registry advertises", () => {
    const ids = qoderCnRegistry.models.map((m) => m.id);
    const uncovered = ids.filter((id) => !EXPECTED[id]);
    // auto/efficient/lite are tier aliases with no published window; everything
    // else must have an exact entry so it never falls through to the 200K default.
    expect(uncovered.sort()).toEqual(["auto", "efficient", "lite"]);
  });

  it("keeps the intl registry model list in sync with the CN list", () => {
    expect(qoderRegistry.models.map((m) => m.id)).toEqual(qoderCnRegistry.models.map((m) => m.id));
  });

  it("aggregates the my-domestic combo at 1M instead of the 200K default", () => {
    const caps = aggregateComboCapabilities(["qdcn/dfmodel", "cbcn/deepseek-v4.1-flash"]);
    expect(caps.contextWindow).toBe(1_000_000);
  });
});
