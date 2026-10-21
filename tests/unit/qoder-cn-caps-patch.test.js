import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The deployment is the PUBLISHED npm artifact, not a build of this repo, so
// patches/qoder-cn-caps.cjs is what actually reaches production. These tests
// run it against a synthetic copy of the shipped bundle shape.
//
// Anchors below are copied verbatim from 9router@0.5.104:
//   .next/server/chunks/24.js, 412.js, 8402.js,
//   .next/static/chunks/5497-d7896a9cac1a7182.js
const SCRIPT = path.resolve(__dirname, "../../patches/qoder-cn-caps.cjs");

const TAIL =
  'q["minimax-code-global"]=q["minimax-code"];let r=[{pattern:"*claude*opus-5*",caps:{}}];';
const BUNDLE = `"use strict";let q={nous:{"stealth/missingno":{contextWindow:262144}}};q["qoder-cn"]=q.qoder,q.cx=q.codex,q.dv=q["devin-cli"],q.devin=q["devin-cli"],${TAIL}`;

// Strip minifier punctuation so the injected chain can be evaluated on its own.
function extractChain(source) {
  const start = source.indexOf("/*9router-qoder-cn-caps*/");
  if (start === -1) return null;
  return source.slice(start, source.indexOf(";let r=[", start));
}

function runPatch(files) {
  return execFileSync(process.execPath, [SCRIPT, ...files], { encoding: "utf8" });
}

function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-cn-caps-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("qoder-cn-caps bundle patch", () => {
  it("injects a CN-only table and rebinds the qdcn alias", () =>
    inTempDir((dir) => {
      const file = path.join(dir, "24.js");
      fs.writeFileSync(file, BUNDLE);

      expect(runPatch([file])).toContain("Patched Qoder CN capabilities");
      const patched = fs.readFileSync(file, "utf8");

      // The dangling `<table>.qoder` lookup must be gone: it is undefined in
      // the shipped bundle and would overwrite the new table.
      expect(patched).not.toContain('["qoder-cn"]=q.qoder');

      const q = { codex: {}, "devin-cli": {}, "minimax-code": {} };
      // eslint-disable-next-line no-new-func
      new Function("q", extractChain(patched))(q);

      expect(q["qoder-cn"].dfmodel.contextWindow).toBe(1000000);
      expect(q["qoder-cn"].kmodel.contextWindow).toBe(256000);
      expect(q["qoder-cn"].mmodel.maxOutput).toBe(512000);
      expect(q["qoder-cn"].qmodel_38max.vision).toBe(true);
      // CN only: no intl table is created.
      expect(q.qoder).toBeUndefined();
      // Alias points at the same object, not a copy.
      expect(q.qdcn).toBe(q["qoder-cn"]);
    }));

  it("is idempotent-safe: refuses to stack onto an already patched bundle", () =>
    inTempDir((dir) => {
      const file = path.join(dir, "24.js");
      fs.writeFileSync(file, BUNDLE);
      runPatch([file]);

      expect(() => runPatch([file])).toThrow(/Already patched/);
    }));

  it("fails loudly when the anchor is missing", () =>
    inTempDir((dir) => {
      const file = path.join(dir, "24.js");
      fs.writeFileSync(file, '"use strict";let q={};q.cx=q.codex;');

      expect(() => runPatch([file])).toThrow(/Unsupported 9router artifact/);
    }));

  it("writes nothing when one of several bundles is unpatched", () =>
    inTempDir((dir) => {
      const good = path.join(dir, "24.js");
      const bad = path.join(dir, "8402.js");
      fs.writeFileSync(good, BUNDLE);
      fs.writeFileSync(bad, '"use strict";let q={};');

      expect(() => runPatch([good, bad])).toThrow(/Unsupported 9router artifact/);
      // All-or-nothing: the valid bundle must be untouched.
      expect(fs.readFileSync(good, "utf8")).toBe(BUNDLE);
    }));
});
