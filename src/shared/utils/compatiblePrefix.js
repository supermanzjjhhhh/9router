/**
 * Compatible provider nodes (OpenAI / Anthropic / custom embedding) use an optional
 * user-defined prefix for model IDs.
 *
 * - Non-empty prefix: clients call `{prefix}/{model}` (existing behavior).
 * - Empty prefix: relay / gateway nodes. Clients call the bare upstream model id
 *   (e.g. `claude-sonnet-4`, `gpt-4o`) with no provider prefix.
 */

export function normalizeCompatiblePrefix(prefix) {
  if (typeof prefix !== "string") return "";
  return prefix.trim();
}

export function isEmptyCompatiblePrefix(prefix) {
  return normalizeCompatiblePrefix(prefix) === "";
}

/**
 * Build the client-facing model ref for a compatible node.
 * Empty prefix → bare model id; otherwise `{prefix}/{modelId}`.
 */
export function formatCompatibleModelRef(prefix, modelId) {
  const p = normalizeCompatiblePrefix(prefix);
  const m = typeof modelId === "string" ? modelId.trim() : "";
  if (!m) return p;
  return p ? `${p}/${m}` : m;
}

/**
 * Resolve a display/output alias for a compatible node while preserving empty prefix.
 * Falls back only when prefix is nullish (missing), not when it is "".
 */
export function resolveCompatibleOutputAlias(prefix, fallback) {
  if (typeof prefix === "string") return prefix.trim();
  if (typeof fallback === "string") return fallback;
  return "";
}

/**
 * Find another node of the same type that already claims the empty prefix.
 * @returns {object|null} conflicting node or null
 */
export function findEmptyPrefixConflict(nodes, { type, excludeId } = {}) {
  if (!Array.isArray(nodes) || !type) return null;
  return (
    nodes.find(
      (node) =>
        node &&
        node.type === type &&
        node.id !== excludeId &&
        isEmptyCompatiblePrefix(node.prefix)
    ) || null
  );
}
