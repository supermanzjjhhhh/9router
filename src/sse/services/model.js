// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getCustomModels } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { isEmptyCompatiblePrefix } from "@/shared/utils/compatiblePrefix";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

const COMPATIBLE_NODE_TYPES = [
  "openai-compatible",
  "anthropic-compatible",
  "custom-embedding",
];

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

async function findCompatibleNodeByPrefix(providerAlias) {
  if (!providerAlias || RESERVED_PROVIDER_PREFIXES.has(providerAlias)) return null;

  for (const type of COMPATIBLE_NODE_TYPES) {
    const nodes = await getProviderNodes({ type });
    const matched = nodes.find((node) => node.prefix === providerAlias);
    if (matched) return matched;
  }
  return null;
}

/**
 * Bare-model fallback for relay/gateway compatible nodes with empty prefix.
 * Preference:
 *  1. empty-prefix node whose custom models explicitly list this model id
 *  2. the single empty-prefix node of a chat-compatible type (openai / anthropic)
 * Never overrides combos or explicit model aliases — those are resolved first.
 */
async function resolveEmptyPrefixCompatibleNode(modelId) {
  if (!modelId || typeof modelId !== "string") return null;

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch {
    customModels = [];
  }

  const chatTypes = ["openai-compatible", "anthropic-compatible"];
  const candidates = [];

  for (const type of chatTypes) {
    const nodes = await getProviderNodes({ type });
    for (const node of nodes) {
      if (!isEmptyCompatiblePrefix(node.prefix)) continue;
      candidates.push(node);
    }
  }

  if (candidates.length === 0) return null;

  const explicit = candidates.find((node) =>
    customModels.some(
      (m) =>
        m?.providerAlias === node.id &&
        typeof m?.id === "string" &&
        m.id === modelId
    )
  );
  if (explicit) {
    return { provider: explicit.id, model: modelId };
  }

  // One empty-prefix chat node → default relay for any bare model id.
  if (candidates.length === 1) {
    return { provider: candidates[0].id, model: modelId };
  }

  // Multiple empty-prefix nodes (typically one openai + one anthropic relay):
  // prefer by model-id shape so bare `claude-*` hits Anthropic Compatible.
  const lower = modelId.toLowerCase();
  const looksAnthropic = lower.startsWith("claude");
  const typed = candidates.filter((node) =>
    looksAnthropic
      ? node.type === "anthropic-compatible"
      : node.type === "openai-compatible"
  );
  if (typed.length === 1) {
    return { provider: typed[0].id, model: modelId };
  }

  // Multiple empty-prefix nodes and no explicit model ownership → ambiguous.
  return null;
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    const matchedNode = await findCompatibleNodeByPrefix(parsed.providerAlias);
    if (matchedNode) {
      return { provider: matchedNode.id, model: parsed.model };
    }

    // Model ids that contain "/" (e.g. "moonshotai/Kimi-K2.5") are parsed as
    // provider/model by parseModelCore. If the left side is not a real provider
    // or compatible prefix, try empty-prefix relay nodes with the FULL original
    // string before falling through to a bogus provider id.
    if (
      parsed.providerAlias &&
      !RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias) &&
      typeof modelStr === "string" &&
      modelStr.includes("/")
    ) {
      const emptyPrefixHit = await resolveEmptyPrefixCompatibleNode(modelStr);
      if (emptyPrefixHit) return emptyPrefixHit;
    }

    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  // Explicit model aliases (user + built-in) win over empty-prefix relay fallback.
  const aliases = await getModelAliases();
  const aliasHit =
    resolveModelAliasFromMap(parsed.model, aliases) ||
    resolveModelAliasFromMap(parsed.model, { "grok-build": "gcli/grok-build" });
  if (aliasHit) return aliasHit;

  // Bare model → empty-prefix compatible relay (new-api / sub2api / grok2api style).
  // Must run BEFORE inferProviderFromModelName so `claude-*` does not hard-wire to
  // the built-in anthropic provider when a relay node is configured.
  const emptyPrefixHit = await resolveEmptyPrefixCompatibleNode(parsed.model);
  if (emptyPrefixHit) return emptyPrefixHit;

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
