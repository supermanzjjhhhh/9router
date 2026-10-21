// Pinned compatibility patch for the published 9router@0.5.104 artifact.
//
// Gives Qoder CN real capability limits in the SHIPPED bundles (no Next.js
// rebuild). Background, see open-sse/providers/capabilities.js:
// upstream 5c217d34 deleted the shared PROVIDER_CAPABILITIES["qoder"] table but
// kept `PROVIDER_CAPABILITIES["qoder-cn"] = PROVIDER_CAPABILITIES["qoder"]`.
// Both sides became undefined, so every Qoder model silently resolved to
// DEFAULT_CAPABILITIES (200K), and combos that min-aggregate member windows
// inherited it (my-domestic = qdcn/dfmodel + cbcn/deepseek-v4.1-flash read
// 200K although dfmodel accepts 1M).
//
// This patch appends an explicit CN-only table and rebinds the qdcn alias.
// It deliberately does NOT define intl "qoder": only the CN gateway is
// verified on the 1M tiers.
//
// Idempotent by construction: a bundle that already contains the marker is
// rewritten from scratch, a bundle whose anchor is missing fails the build.
const fs = require("node:fs");

const MARKER = "9router-qoder-cn-caps";

// Same values as the source table in open-sse/providers/capabilities.js.
const CN_TABLE = {
  ultimate: [1000000, 128000, 1],
  performance: [1000000, 128000, 1],
  dmodel: [1000000, 65536, 0],
  dfmodel: [1000000, 65536, 0],
  gmodel: [1000000, 128000, 0],
  gfmodel: [1000000, 128000, 1],
  kmodel_latest: [1000000, 65536, 1],
  kmodel: [256000, 65536, 1],
  mmodel: [1000000, 512000, 0],
  qmodel_latest: [1000000, 65536, 1],
  qmodel: [1000000, 65536, 1],
  qfmodel: [1000000, 65536, 1],
  qmodel_38max: [1000000, 65536, 1],
};

const THINKING = {
  ultimate: "claude-adaptive",
  performance: "claude-adaptive",
  dmodel: "deepseek",
  dfmodel: "deepseek",
  gmodel: "zai",
  gfmodel: "zai",
  kmodel_latest: "kimi",
  kmodel: "kimi",
  mmodel: "minimax",
  qmodel_latest: "qwen",
  qmodel: "qwen",
  qfmodel: "qwen",
  qmodel_38max: "qwen",
};

// Compact object literal, matching the minified style of the bundle.
const rows = Object.entries(CN_TABLE)
  .map(([id, [ctx, out, vision]]) => {
    const fields = [`reasoning:!0`];
    if (vision) fields.push("vision:!0");
    fields.push(
      `thinkingFormat:"${THINKING[id]}"`,
      "thinkingCanDisable:!1",
      `contextWindow:${ctx}`,
      `maxOutput:${out}`
    );
    return `${JSON.stringify(id)}:{${fields.join(",")}}`;
  })
  .join(",");

// The anchor is the dangling alias line every copy of capabilities.js ships:
//   <target>["qoder-cn"]=<table>.qoder
// It sits inside a comma chain (`...=q.qoder,q.cx=q.codex,...`), so the
// replacement must stay comma-separated and must NOT re-emit the anchor — the
// old `<table>.qoder` value is undefined and would overwrite the new table.
const ANCHOR = /([A-Za-z_$]+)\["qoder-cn"\]=([A-Za-z_$]+)\.qoder/g;
const marker = `/*${MARKER}*/`;

function patchSource(source, file) {
  if (source.includes(marker)) {
    throw new Error(`Already patched (refusing to stack): ${file}`);
  }
  const matches = [...source.matchAll(ANCHOR)];
  if (matches.length !== 1) {
    throw new Error(
      `Unsupported 9router artifact, expected exactly 1 qoder-cn alias anchor in ${file}, found ${matches.length}`
    );
  }
  const [anchor, target] = matches[0];
  const injected =
    `/*${MARKER}*/${target}["qoder-cn"]={${rows}},` +
    `${target}.qdcn=${target}["qoder-cn"]`;
  return source.replace(anchor, injected);
}

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass the 0.5.104 bundle paths to patch");

// Validate every copy before writing any of them, so a partial patch never
// reaches an image layer.
const updates = files.map((file) => {
  const source = fs.readFileSync(file, "utf8");
  return [file, patchSource(source, file)];
});
for (const [file, source] of updates) {
  fs.writeFileSync(file, source);
  console.log(`Patched Qoder CN capabilities: ${file}`);
}
