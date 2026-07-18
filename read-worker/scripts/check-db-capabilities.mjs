#!/usr/bin/env node
// Build tripwire for the database-capability contract (MS2-FR-29b):
//   1. The D1 bindings (CONTENT_DB / OPS_DB) are referenced ONLY by src/db.ts (the
//      capability module) and src/env.ts / src/health.ts (type + presence check).
//   2. src/db.ts still contains the SELECT-only guard for content.
//   3. No module uses a raw legacy binding (env.DB) or bypasses the capabilities
//      with a direct .prepare on a binding.
//   4. The content layer (data.ts) contains no write-statement SQL at all.
// Run via `npm test` — drift fails the build, not the database.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const failures = [];

const files = readdirSync(srcDir, { recursive: true })
  .filter((f) => f.toString().endsWith(".ts"))
  .map((f) => f.toString());

const BINDING_ALLOWED = new Set(["db.ts", "env.ts", "health.ts"]);

for (const file of files) {
  const text = readFileSync(join(srcDir, file), "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    const loc = `${file}:${i + 1}`;
    const code = line.replace(/\/\/.*$/, ""); // ignore comments

    if (/\b(CONTENT_DB|OPS_DB)\b/.test(code) && !BINDING_ALLOWED.has(file)) {
      failures.push(`${loc}: D1 binding referenced outside the capability module`);
    }
    if (/\benv\.DB\b/.test(code)) {
      failures.push(`${loc}: legacy env.DB binding — use contentQuery/opsQuery from db.ts`);
    }
  });

  if (file === "data.ts" && /\b(INSERT|UPDATE|DELETE)\b/i.test(text.replace(/\/\/[^\n]*/g, ""))) {
    failures.push(`data.ts: content layer contains a write statement — it must be SELECT-only`);
  }
}

const db = readFileSync(join(srcDir, "db.ts"), "utf8");
if (!/if \(!\/\^\\s\*SELECT\\b\/i\.test\(sql\)\)/.test(db)) {
  failures.push("db.ts: the SELECT-only guard on contentQuery is missing");
}

if (failures.length > 0) {
  console.error("DB capability check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`DB capability check passed (${files.length} files).`);
