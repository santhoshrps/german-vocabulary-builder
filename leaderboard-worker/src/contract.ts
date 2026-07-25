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
  | "session"          // valid social JWT (aud=leaderboard, env, session_version)
  | "sessionIntegrity"; // session + App Attest / Play Integrity verdict (IDENT-7)

export interface RouteSpec {
  method: "GET" | "POST" | "DELETE";
  path: string;
  auth: AuthLevel;
  /** Contract row, for traceability in tests and logs. */
  id: string;
}

export const BASE = "/v3/leaderboard";

export const ROUTES: RouteSpec[] = [
  { id: "R1", method: "GET", path: `${BASE}/capability`, auth: "public" },
  { id: "R2", method: "GET", path: `${BASE}/health`, auth: "public" },
  { id: "R3", method: "POST", path: `${BASE}/auth/nonce`, auth: "public" },
  { id: "R4", method: "POST", path: `${BASE}/auth/exchange`, auth: "public" },
  { id: "R5", method: "POST", path: `${BASE}/auth/refresh`, auth: "public" },
  { id: "R6", method: "POST", path: `${BASE}/auth/signout`, auth: "session" },
  { id: "R7", method: "POST", path: `${BASE}/profile/join`, auth: "sessionIntegrity" },
  { id: "R8", method: "GET", path: `${BASE}/profile`, auth: "session" },
  { id: "R9", method: "GET", path: `${BASE}/profile/export`, auth: "session" },
  { id: "R10", method: "DELETE", path: `${BASE}/profile`, auth: "sessionIntegrity" },
  { id: "R11", method: "GET", path: `${BASE}/profile/delete-status`, auth: "capability" },
  { id: "R12", method: "POST", path: `${BASE}/publish`, auth: "sessionIntegrity" },
  { id: "R13", method: "GET", path: `${BASE}/board`, auth: "session" },
  { id: "R14", method: "GET", path: `${BASE}/invites`, auth: "session" },
  { id: "R15", method: "POST", path: `${BASE}/invites`, auth: "sessionIntegrity" },
  { id: "R16", method: "POST", path: `${BASE}/invites/withdraw`, auth: "session" },
  { id: "R17", method: "POST", path: `${BASE}/invites/preview`, auth: "inviteToken" },
  { id: "R18", method: "POST", path: `${BASE}/invites/accept`, auth: "sessionIntegrity" },
  { id: "R19", method: "POST", path: `${BASE}/friends/remove`, auth: "session" },
  { id: "R20", method: "POST", path: `${BASE}/blocks`, auth: "session" },
  { id: "R20b", method: "POST", path: `${BASE}/blocks/remove`, auth: "sessionIntegrity" },
  { id: "R21", method: "POST", path: `${BASE}/mutes`, auth: "session" },
  { id: "R21b", method: "POST", path: `${BASE}/mutes/remove`, auth: "session" },
  { id: "R22", method: "POST", path: `${BASE}/cheers`, auth: "sessionIntegrity" },
  { id: "R23", method: "POST", path: `${BASE}/reports`, auth: "sessionIntegrity" },
  { id: "R24", method: "GET", path: `${BASE}/e18/receipts`, auth: "session" },
  { id: "R25", method: "POST", path: `${BASE}/e18/receipts/ack`, auth: "session" },
];

/** Stable error codes — the CLOSED registry (contract §3). Clients branch on these,
 *  never on text; additions bump the schema version. */
export const ERROR_CODES = [
  "OK",
  "AUTH_INVALID", "AUTH_EXPIRED", "AUTH_REFRESH_REUSED", "AUTH_RECENT_REQUIRED",
  "INTEGRITY_CHALLENGE", "INTEGRITY_DENIED",
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
