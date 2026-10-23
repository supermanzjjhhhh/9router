const fs = require("node:fs");
const vm = require("node:vm");

// 1. Qoder CN context_config object format
const f1 = "/app/.next/server/chunks/5330.js";
const s1 = fs.readFileSync(f1, "utf8");
const n1 = "let b=a?.context_config??a?.contextConfig;if(!Array.isArray(b))return[];";
const r1 = 'let b=a?.context_config??a?.contextConfig;if(b&&typeof b==="object"&&!Array.isArray(b))b=Object.entries(b).filter(([,value])=>value&&typeof value==="object"&&!Array.isArray(value)).map(([name,value])=>({...value,name:value.name??name}));if(!Array.isArray(b))return[];';
if (s1.split(n1).length !== 2) throw new Error("Needle 1 not found or multiple occurrences");
const p1 = s1.replace(n1, r1);
new vm.Script(p1);
fs.writeFileSync(f1, p1);
console.log("Patched Qoder context config:", f1);

// 2. Usage provider filter
const f2 = "/app/.next/server/app/api/usage/providers/route.js";
const s2 = fs.readFileSync(f2, "utf8");
const n2 = "let a=await (0,e.Lk)(),b=await (0,f.Fh)(),c={};";
const r2 = 'let a=[...new Set([...(await (0,e.Lk)()),...(await (0,f.getProviderConnections)()).map(a=>a.provider)])].filter(Boolean).sort(),b=await (0,f.Fh)(),c={};';
if (s2.split(n2).length !== 2) throw new Error("Needle 2 not found or multiple occurrences");
const p2 = s2.replace(n2, r2);
new vm.Script(p2);
fs.writeFileSync(f2, p2);
console.log("Patched usage provider filter:", f2);
