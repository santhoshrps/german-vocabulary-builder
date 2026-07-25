#!/usr/bin/env node
// Runs every local Worker suite even when an earlier contract assertion fails.
// A red architecture gate must not hide independent auth/deletion regressions.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const suites = [
  "routes.test.mjs",
  "architecture.test.mjs",
  "policy.test.mjs",
  "algebra.test.mjs",
  "auth.test.mjs",
  "idempotency.test.mjs",
  "invite-policy.test.mjs",
  "publish-policy.test.mjs",
  "board-policy.test.mjs",
  "deletion.test.mjs",
];

const failures = [];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [join(testDirectory, suite)], {
    cwd: dirname(testDirectory),
    stdio: "inherit",
  });
  if (result.status !== 0) failures.push(suite);
}

if (failures.length) {
  console.error(`\nleaderboard unit suites failed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nleaderboard unit suites passed: ${suites.length}`);
}
