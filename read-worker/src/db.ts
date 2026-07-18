// Database capability modules (MS2-FR-29b).
//
// This file is the ONLY module allowed to touch the D1 bindings. Everything else
// acquires a statement through one of the two capabilities below, so the rights of
// each database are enforced by construction, not by review:
//
//   contentQuery — the CONTENT database (vocabulary tables + meta). This worker's
//                  content access is READ-ONLY by contract: the guard refuses any
//                  statement that is not a SELECT, so an accidental write slipping
//                  into the content path in a future change fails loudly instead of
//                  mutating the published vocabulary. Content is written only by the
//                  publish pipeline through the write worker.
//   opsQuery     — the OPS database (devices, sessions' promo claims, submissions,
//                  feedback, search usage, challenges, rate limits). Read-write:
//                  this is the worker's own operational state.
//
// scripts/check-db-capabilities.mjs (run in CI/test) statically asserts that the
// bindings appear in no other module — drift fails the build, not the database.

import { Env } from "./env";

export function contentQuery(env: Env, sql: string): D1PreparedStatement {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error(`content database is read-only; refused non-SELECT: ${sql.trim().slice(0, 40)}`);
  }
  return env.CONTENT_DB.prepare(sql);
}

export function opsQuery(env: Env, sql: string): D1PreparedStatement {
  return env.OPS_DB.prepare(sql);
}
