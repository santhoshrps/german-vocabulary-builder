// Leaderboard worker — routing, default-deny auth guard, envelope (batch W1).
//
// Implements docs/generic/leaderboard/design/server-contract.md §1–§3 skeleton:
// every request resolves through the contract's ROUTES table; the auth level is
// enforced BEFORE any handler (including NOT_IMPLEMENTED); responses are the
// versioned envelope { v, requestId, code, data? }. Session/capability/invite
// verification lands in W2 — until then every non-public level fails closed.

import { BASE, ErrorCode, ROUTES, RouteSpec, SCHEMA_VERSION } from "./contract";
import {
  SessionContext, handleExchange, handleNonce, handleRefresh, handleSignout,
  verifyJoinSession, verifySession,
} from "./auth";
import { handleJoin, handleProfile } from "./profile";
import { handlePublish } from "./publish";
import { handleBoard } from "./board";

export interface Env {
  SOCIAL_DB: D1Database;
  ERASURE_DB: D1Database;
  PROJECTION_1: D1Database;
  ENV_NAME: string;
  APP_BUNDLE_ID: string;
  SOCIAL_JWT_SECRET: string;
  IDENTITY_HMAC_KEY_V1: string;
  DEPLOY_VERSION?: string;
  /** Optional capability overrides (NFR-10b). */
  CAPABILITY_STATE?: string; // healthy | maintenance | disabled
  MIN_BUILD?: string;
}

type Handler = (request: Request, env: Env, requestId: string, ctx: SessionContext | null) => Promise<Response>;

const STATUS: Partial<Record<ErrorCode, number>> = {
  OK: 200,
  AUTH_INVALID: 401, AUTH_EXPIRED: 401, AUTH_REFRESH_REUSED: 401,
  AUTH_RECENT_REQUIRED: 403, INTEGRITY_CHALLENGE: 403, INTEGRITY_DENIED: 403,
  SCHEMA_VERSION_UNSUPPORTED: 400, SCHEMA_UNKNOWN_FIELD: 400, SCHEMA_INVALID: 400,
  NICKNAME_INVALID: 400,
  LIMIT_FRIENDS: 409, LIMIT_INVITES_DAY: 409, LIMIT_CHEER_DAY: 409,
  LIMIT_REPORTS_DAY: 409, LIMIT_BLOCKS: 409,
  INVITE_EXPIRED: 409, INVITE_CONSUMED: 409, INVITE_WITHDRAWN: 409,
  INVITE_OWN: 409, ALREADY_FRIENDS: 409, GENERATION_STALE: 409,
  PUBLISH_ENVELOPE_EXCEEDED: 422, PUBLISH_REBASE_REQUIRED: 409,
  IDEMPOTENCY_MISMATCH: 422, RATE_LIMITED: 429,
  MAINTENANCE: 503, DISABLED: 403, MIN_BUILD: 403, PROFILE_GONE: 410,
  NOT_FOUND: 404, NOT_IMPLEMENTED: 501, INTERNAL: 500,
};

export function envelope(
  requestId: string, code: ErrorCode, data?: unknown,
  headers: Record<string, string> = {},
): Response {
  const status = STATUS[code] ?? 500;
  return new Response(JSON.stringify({ v: SCHEMA_VERSION, requestId, code, ...(data !== undefined ? { data } : {}) }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// --- W1 handlers -----------------------------------------------------------

/** /health — the deploy gate's wire-verify shape ({status, env, version, missing[]})
 *  plus per-store schema probes: a missing migration fails the deploy, not a user. */
const health: Handler = async (_request, env, requestId) => {
  const missing: string[] = [];
  const probes: Array<[string, D1Database, string]> = [
    ["SOCIAL_DB", env.SOCIAL_DB, "players"],
    ["ERASURE_DB", env.ERASURE_DB, "erasure_saga"],
    ["PROJECTION_1", env.PROJECTION_1, "day_state"],
  ];
  for (const [name, db, table] of probes) {
    try {
      if (!db) throw new Error("binding absent");
      await db.prepare(`SELECT count(*) AS n FROM ${table}`).first();
    } catch {
      missing.push(`${name}.${table}`);
    }
  }
  if (!env.ENV_NAME) missing.push("ENV_NAME");
  const body = {
    status: missing.length === 0 ? "ok" : "failing",
    env: env.ENV_NAME ?? "unknown",
    version: env.DEPLOY_VERSION ?? "undeployed",
    schemaVersion: SCHEMA_VERSION,
    ...(missing.length ? { missing } : {}),
  };
  // Health is intentionally NOT enveloped — deploy.sh and dashboards read this shape.
  void requestId;
  return new Response(JSON.stringify(body), {
    status: missing.length === 0 ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
};

/** /capability — versioned availability (NFR-10b). Clients branch on state before
 *  showing any social entry point; MIN_BUILD gates old clients honestly. */
const capability: Handler = async (_request, env, requestId) => {
  const state = env.CAPABILITY_STATE ?? "healthy";
  return envelope(requestId, "OK", {
    state,
    minBuild: Number(env.MIN_BUILD ?? 1),
    schemaVersion: SCHEMA_VERSION,
  });
};

// Handlers by contract id — filled batch by batch. A declared route with no
// handler answers NOT_IMPLEMENTED (after auth enforcement).
const HANDLERS: Partial<Record<string, Handler>> = {
  R1: capability,
  R2: health,
  R3: async (request, env, requestId) => fromResult(requestId, await handleNonce(request, env)),
  R4: async (request, env, requestId) => fromResult(requestId, await handleExchange(request, env)),
  R5: async (request, env, requestId) => fromResult(requestId, await handleRefresh(request, env)),
  R6: async (_request, env, requestId, ctx) => fromResult(requestId, await handleSignout(env, ctx!)),
  R7: async (request, env, requestId) => {
    // Join accepts BOTH the pre-join principal and a full session (idempotent).
    const principal = await verifyJoinSession(request, env);
    if (principal.code) return envelope(requestId, principal.code);
    return fromResult(requestId, await handleJoin(request, env, principal));
  },
  R8: async (_request, env, requestId, ctx) => fromResult(requestId, await handleProfile(env, ctx!)),
  R12: async (request, env, requestId, ctx) => fromResult(requestId, await handlePublish(request, env, ctx!)),
  R13: async (request, env, requestId, ctx) => {
    const result = await handleBoard(request, env, ctx!);
    if (result.notModified) return new Response(null, { status: 304, headers: result.headers });
    return envelope(requestId, result.code, result.data, result.headers ?? {});
  },
};

function fromResult(requestId: string, result: { code: ErrorCode; data?: unknown }): Response {
  return envelope(requestId, result.code, result.data);
}

// R7 verifies its own dual principal inside the handler.
const SELF_AUTHORIZING = new Set(["R7"]);

// --- auth guard (default-deny; capability/inviteToken levels land with their routes) --

async function authorize(
  route: RouteSpec, request: Request, env: Env,
): Promise<{ refusal: ErrorCode | null; ctx: SessionContext | null }> {
  if (SELF_AUTHORIZING.has(route.id)) return { refusal: null, ctx: null };
  switch (route.auth) {
    case "public":
      return { refusal: null, ctx: null };
    case "session":
    case "sessionIntegrity": {
      // IDENT-7: the integrity signal is parsed with the verdict matrix at the
      // sessionIntegrity routes; "unavailable" maps to the tighten column, never
      // a silent allow. Full App Attest assertion verification (stored key +
      // counter, read-worker appattest module) lands with W4 before any
      // mutation route ships enabled to real users.
      const session = await verifySession(request, env);
      return session.ok ? { refusal: null, ctx: session.ctx } : { refusal: session.code, ctx: null };
    }
    case "capability":
    case "inviteToken":
      // Their sole routes (R11 delete-status, R17 preview) arrive in W4/W5;
      // until then fail closed.
      return { refusal: "AUTH_INVALID", ctx: null };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(request.url);
      // Root /health is the deploy pipeline's wire-verify convention (shared with the
      // read worker); the same handler also answers at the contract's R2 path.
      if (url.pathname === "/health" && request.method === "GET") {
        return health(request, env, requestId, null);
      }
      if (!url.pathname.startsWith(BASE)) return envelope(requestId, "NOT_FOUND");
      const route = ROUTES.find((r) => r.path === url.pathname && r.method === request.method);
      if (!route) return envelope(requestId, "NOT_FOUND");

      const { refusal, ctx } = await authorize(route, request, env);
      if (refusal) return envelope(requestId, refusal);

      const handler = HANDLERS[route.id];
      if (!handler) return envelope(requestId, "NOT_IMPLEMENTED");
      return await handler(request, env, requestId, ctx);
    } catch (error) {
      console.error(JSON.stringify({ requestId, outcome: "INTERNAL", error: String(error) }));
      return envelope(requestId, "INTERNAL");
    }
  },

  // Queue-less v1 (LB3-NFR-1b): the cron drives the outbox executor. The executor
  // arrives in W5; until then the tick is a safe no-op that proves the trigger path.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    console.log(JSON.stringify({ cron: "tick", env: env.ENV_NAME, outbox: "not-yet-implemented" }));
  },
} satisfies ExportedHandler<Env>;
