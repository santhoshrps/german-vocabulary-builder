// The wire contract as data (docs/generic/leaderboard/design/server-contract.md).
//
// The route table is the single source the router dispatches from and the
// route-enumeration test asserts against (LB3-NFR-4f: default-deny — a route that
// is not declared here does not exist, and the public allowlist is exactly the
// contract's). Handlers arrive batch by batch; a declared route without a handler
// answers NOT_IMPLEMENTED — after its auth level has been enforced.

export type AuthLevel =
  | "public"           // allowlisted: capability, health, auth bootstrap
  | "capability"       // deletion-status capability hash (works after session death)
  | "inviteToken"      // possession of an invite token (preview only)
  | "session";         // valid social JWT (aud=leaderboard, app, env, session_version)

/** How a route's replays are made safe (contract §2): GET/health are `none`
 *  (nothing to dedupe); auth/publish/delete are `natural` (the operation itself
 *  converges on replay — rotation grace, idempotent merge, tombstoned erasure);
 *  social writes are `key` (the client's Idempotency-Key row is authoritative). */
export type IdempotencyPolicy = "none" | "natural" | "key";

export interface RouteSpec {
  method: "GET" | "POST" | "DELETE";
  path: string;
  auth: AuthLevel;
  /** Contract row, for traceability in tests and logs. */
  id: string;
  /** Absolute request-body ceiling in bytes; 0 for bodyless GETs. The router
   *  refuses anything larger before a handler or JSON.parse runs (SEC-010). */
  bodyLimit: number;
  /** Replay-safety policy (above). */
  idempotency: IdempotencyPolicy;
  /** Accepted request content types; empty for bodyless GETs. */
  contentTypes: readonly string[];
}

export const BASE = "/v3/leaderboard";

// Shared body policies — the route table stays the single source, and every
// route declares its policy explicitly (default-deny: an omitted policy is a
// contract error the architecture test catches).
const NO_BODY = { bodyLimit: 0, idempotency: "none", contentTypes: [] } as const;
const AUTH_BODY = { bodyLimit: 8192, idempotency: "natural", contentTypes: ["application/json"] } as const;
const SMALL_NATURAL = { bodyLimit: 2048, idempotency: "natural", contentTypes: ["application/json"] } as const;
const JSON_KEYED = { bodyLimit: 4096, idempotency: "key", contentTypes: ["application/json"] } as const;
const JSON_NATURAL = { bodyLimit: 4096, idempotency: "natural", contentTypes: ["application/json"] } as const;
const PUBLISH_BODY = { bodyLimit: 1_048_576, idempotency: "natural", contentTypes: ["application/json"] } as const;

export const ROUTES: RouteSpec[] = [
  { id: "R1", method: "GET", path: `${BASE}/capability`, auth: "public", ...NO_BODY },
  { id: "R2", method: "GET", path: `${BASE}/health`, auth: "public", ...NO_BODY },
  { id: "R3", method: "POST", path: `${BASE}/auth/nonce`, auth: "public", ...SMALL_NATURAL },
  { id: "R4", method: "POST", path: `${BASE}/auth/exchange`, auth: "public", ...AUTH_BODY },
  { id: "R5", method: "POST", path: `${BASE}/auth/refresh`, auth: "public", ...SMALL_NATURAL },
  { id: "R6", method: "POST", path: `${BASE}/auth/signout`, auth: "session", ...SMALL_NATURAL },
  { id: "R7", method: "POST", path: `${BASE}/profile/join`, auth: "session", ...JSON_KEYED },
  { id: "R8", method: "GET", path: `${BASE}/profile`, auth: "session", ...NO_BODY },
  { id: "R9", method: "GET", path: `${BASE}/profile/export`, auth: "session", ...NO_BODY },
  { id: "R10", method: "DELETE", path: `${BASE}/profile`, auth: "session", ...SMALL_NATURAL },
  { id: "R11", method: "GET", path: `${BASE}/profile/delete-status`, auth: "capability", ...NO_BODY },
  { id: "R12", method: "POST", path: `${BASE}/publish`, auth: "session", ...PUBLISH_BODY },
  { id: "R13", method: "GET", path: `${BASE}/board`, auth: "session", ...NO_BODY },
  { id: "R14", method: "GET", path: `${BASE}/invites`, auth: "session", ...NO_BODY },
  { id: "R15", method: "POST", path: `${BASE}/invites`, auth: "session", ...JSON_KEYED },
  { id: "R16", method: "POST", path: `${BASE}/invites/withdraw`, auth: "session", ...JSON_KEYED },
  { id: "R17", method: "POST", path: `${BASE}/invites/preview`, auth: "inviteToken", ...JSON_NATURAL },
  { id: "R18", method: "POST", path: `${BASE}/invites/accept`, auth: "session", ...JSON_KEYED },
  { id: "R19", method: "POST", path: `${BASE}/friends/remove`, auth: "session", ...JSON_KEYED },
  { id: "R20", method: "POST", path: `${BASE}/blocks`, auth: "session", ...JSON_KEYED },
  { id: "R20b", method: "POST", path: `${BASE}/blocks/remove`, auth: "session", ...JSON_KEYED },
  { id: "R21", method: "POST", path: `${BASE}/mutes`, auth: "session", ...JSON_KEYED },
  { id: "R21b", method: "POST", path: `${BASE}/mutes/remove`, auth: "session", ...JSON_KEYED },
  { id: "R22", method: "POST", path: `${BASE}/cheers`, auth: "session", ...JSON_KEYED },
  { id: "R23", method: "POST", path: `${BASE}/reports`, auth: "session", ...JSON_KEYED },
  { id: "R24", method: "GET", path: `${BASE}/e18/receipts`, auth: "session", ...NO_BODY },
  { id: "R25", method: "POST", path: `${BASE}/e18/receipts/ack`, auth: "session", ...JSON_KEYED },
];

/** Stable error codes — the CLOSED registry (contract §3). Clients branch on these,
 *  never on text; additions bump the schema version. */
export const ERROR_CODES = [
  "OK",
  "AUTH_INVALID", "AUTH_EXPIRED", "AUTH_REFRESH_REUSED", "AUTH_RECENT_REQUIRED",
  "SCHEMA_VERSION_UNSUPPORTED", "SCHEMA_UNKNOWN_FIELD", "SCHEMA_INVALID",
  "NICKNAME_INVALID",
  "LIMIT_FRIENDS", "LIMIT_INVITES_DAY", "LIMIT_CHEER_DAY", "LIMIT_REPORTS_DAY", "LIMIT_BLOCKS",
  "INVITE_EXPIRED", "INVITE_CONSUMED", "INVITE_WITHDRAWN", "INVITE_OWN", "ALREADY_FRIENDS",
  "GENERATION_STALE",
  "PUBLISH_ENVELOPE_EXCEEDED", "PUBLISH_REBASE_REQUIRED",
  "IDEMPOTENCY_MISMATCH",
  "RATE_LIMITED",
  "MAINTENANCE", "DISABLED", "MIN_BUILD",
  "PROFILE_GONE",
  "NOT_FOUND", "NOT_IMPLEMENTED", "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Current request/response schema version (contract §1/§6). */
export const SCHEMA_VERSION = 1;
