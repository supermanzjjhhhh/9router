// Pinned compatibility patch for the published 9router@0.5.104 artifact.
// Keep array catalogs unchanged; adapt named CN tiers before the existing parser.
const fs = require("node:fs");

const needle = "let b=a?.context_config??a?.contextConfig;if(!Array.isArray(b))return[];";
const replacement = "let b=a?.context_config??a?.contextConfig;"
  + 'if(b&&typeof b==="object"&&!Array.isArray(b))b=Object.entries(b)'
  + '.filter(([,value])=>value&&typeof value==="object"&&!Array.isArray(value))'
  + '.map(([name,value])=>({...value,name:value.name??name}));'
  + "if(!Array.isArray(b))return[];";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass the 0.5.104 server bundle paths to patch");
const updates = files.map((file) => {
  const source = fs.readFileSync(file, "utf8");
  if (source.split(needle).length !== 2) {
    throw new Error(`Unsupported or already patched 9router artifact: ${file}`);
  }
  return [file, source.replace(needle, replacement)];
});
// Validate every copy before changing any of them. A failed image layer is discarded.
for (const [file, source] of updates) {
  fs.writeFileSync(file, source);
  console.log(`Patched Qoder context catalog: ${file}`);
}
