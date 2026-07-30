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
import {
  handleBlock, handleCheer, handleInviteAccept, handleInviteCreate,
  handleInvitePreview, handleInviteWithdraw, handleInvitesList, handleMute,
  handleReceiptAck, handleReceiptsList, handleRemove, handleReport,
  handleUnblock, withIdempotency,
} from "./social";
import { handleDelete, handleDeleteStatus, handleExport, runOutboxTick } from "./deletion";
import { APP_STORE_BADGE_SVG } from "./app-store-badge";

export interface Env {
  SOCIAL_DB: D1Database;
  ERASURE_DB: D1Database;
  PROJECTION_1: D1Database;
  ENV_NAME: string;
  APP_BUNDLE_ID: string;
  /** This deployment's application tenant — the URL's first path segment
   *  ("german"; later "spanish", …). Every token, storage namespace, quota key and
   *  log line is scoped by it. Declared per environment in wrangler.toml and NEVER
   *  derived from a request path or client header: a request selects a backend, it
   *  does not get to say which app's data that backend serves. */
  APP_SLUG: string;
  SOCIAL_JWT_SECRET: string;
  IDENTITY_HMAC_KEY_V1: string;
  DEPLOY_VERSION?: string;
  APP_TEAM_ID?: string;
  /** SIWA key (owner-provisioned secrets) — S5 revocation + code exchange. */
  APPLE_SIWA_KEY_P8?: string;
  APPLE_SIWA_KEY_ID?: string;
  /** Optional capability overrides (NFR-10b). */
  CAPABILITY_STATE?: string; // healthy | maintenance | disabled
  MIN_BUILD?: string;
  /** Prod: https://learn-languages.app/german/join (owner 2026-07-25); dev: "" → worker origin. */
  INVITE_LINK_BASE?: string;
}

type Handler = (request: Request, env: Env, requestId: string, ctx: SessionContext | null) => Promise<Response>;

const STATUS: Partial<Record<ErrorCode, number>> = {
  OK: 200,
  AUTH_INVALID: 401, AUTH_EXPIRED: 401, AUTH_REFRESH_REUSED: 401,
  AUTH_RECENT_REQUIRED: 403,
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

// --- request-body defense (TS-LB3-SEC-010/011/012; publish-policy.test) -----
//
// A publish body is bounded THREE ways before any handler or JSON.parse touches
// it: an absolute byte ceiling, a nesting-depth bound, and duplicate-key
// rejection. The depth + duplicate scan is a single left-to-right pass over the
// raw text — a nesting bomb (deeply nested arrays/objects that blow the parser
// stack) and a duplicate-key ambiguity (two "days" keys, last-wins) are refused
// at the router, never reaching the merge. This is defense-in-depth: the
// handler validates shape too, but the router never lets a bomb reach it.
const MAX_PUBLISH_BYTES = 1_048_576; // 1 MiB hard ceiling — 1024 * 1024
const MAX_JSON_DEPTH = 24;

/** One-pass canonical-JSON scan: returns a wire code when the text exceeds the
 *  byte ceiling, nests deeper than MAX_JSON_DEPTH, or repeats a key within one
 *  object; null when the text is structurally safe to parse. */
function guardRequestBody(text: string, maxBytes: number): ErrorCode | null {
  if (new TextEncoder().encode(text).length > maxBytes) return "SCHEMA_INVALID";
  type Frame = { obj: boolean; keys?: Set<string>; expectKey?: boolean };
  const frames: Frame[] = [];
  let inString = false, escaped = false, current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; current += ch; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') {
        inString = false;
        const top = frames[frames.length - 1];
        if (top?.obj && top.expectKey) {
          if (top.keys!.has(current)) return "SCHEMA_INVALID"; // duplicate key
          top.keys!.add(current);
          top.expectKey = false;
        }
        current = "";
      } else current += ch;
      continue;
    }
    switch (ch) {
      case '"': inString = true; current = ""; break;
      case "{":
        frames.push({ obj: true, keys: new Set(), expectKey: true });
        if (frames.length > MAX_JSON_DEPTH) return "SCHEMA_INVALID"; // nesting/depth bomb
        break;
      case "[":
        frames.push({ obj: false });
        if (frames.length > MAX_JSON_DEPTH) return "SCHEMA_INVALID"; // nesting/depth bomb
        break;
      case "}": case "]": frames.pop(); break;
      case ",": { const top = frames[frames.length - 1]; if (top?.obj) top.expectKey = true; break; }
      default: break;
    }
  }
  return null;
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
  // A deployment with no APP_SLUG would compare an absent token claim against an
  // absent config value and PASS — the silent-default hazard. The request path
  // stays a strict equality check; this makes the misconfiguration fail the
  // deploy's health gate instead of shipping a worker that accepts unscoped tokens.
  if (!env.APP_SLUG) missing.push("APP_SLUG");
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
  R12: async (request, env, requestId, ctx) => {
    // Router body defense before the handler: byte ceiling, depth bound, no
    // duplicate keys. Read a clone so handlePublish still parses the original.
    const guard = guardRequestBody(await request.clone().text(), MAX_PUBLISH_BYTES);
    if (guard) return envelope(requestId, guard);
    return fromResult(requestId, await handlePublish(request, env, ctx!));
  },
  R13: async (request, env, requestId, ctx) => {
    const result = await handleBoard(request, env, ctx!);
    if (result.notModified) return new Response(null, { status: 304, headers: result.headers });
    return envelope(requestId, result.code, result.data, result.headers ?? {});
  },
  R14: async (_request, env, requestId, ctx) => fromResult(requestId, await handleInvitesList(env, ctx!)),
  R15: async (request, env, requestId, ctx) =>
    fromResult(requestId, await withIdempotency(request, env, ctx!, "invites", "", () =>
      handleInviteCreate(request, env, ctx!))),
  R16: mutation("invites/withdraw", (body, env, ctx) => handleInviteWithdraw(body, env, ctx)),
  R17: async (request, env, requestId) =>
    fromResult(requestId, await handleInvitePreview(request, env)),
  R17b: async (request, env, requestId, ctx) =>
    fromResult(requestId, await handleInvitePreview(request, env, ctx!)),
  R18: mutation("invites/accept", (body, env, ctx) => handleInviteAccept(body, env, ctx)),
  R19: mutation("friends/remove", (body, env, ctx) => handleRemove(body, env, ctx)),
  R20: mutation("blocks", (body, env, ctx) => handleBlock(body, env, ctx)),
  R20b: mutation("blocks/remove", (body, env, ctx) => handleUnblock(body, env, ctx)),
  R21: mutation("mutes", (body, env, ctx) => handleMute(body, env, ctx, true)),
  R21b: mutation("mutes/remove", (body, env, ctx) => handleMute(body, env, ctx, false)),
  R22: mutation("cheers", (body, env, ctx) => handleCheer(body, env, ctx)),
  R23: mutation("reports", (body, env, ctx) => handleReport(body, env, ctx)),
  R24: async (_request, env, requestId, ctx) => fromResult(requestId, await handleReceiptsList(env, ctx!)),
  R25: mutation("e18/ack", (body, env, ctx) => handleReceiptAck(body, env, ctx)),
  R9: async (_request, env, requestId, ctx) => fromResult(requestId, await handleExport(env, ctx!)),
  R10: async (_request, env, requestId, ctx) => {
    const result = await handleDelete(env, ctx!);
    if (result.status === 202) {
      return new Response(JSON.stringify({ v: SCHEMA_VERSION, requestId, code: "OK", data: result.data }), {
        status: 202, headers: { "content-type": "application/json" },
      });
    }
    return envelope(requestId, result.code, result.data);
  },
  R11: async (request, env, requestId) => fromResult(requestId, await handleDeleteStatus(request, env)),
};

const APP_STORE_ID = "6786836287";
const APP_STORE_PRODUCT_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

/** The invite landing page (FRIEND-1b): no-referrer, strict CSP, zero third-party
 *  resources; the fragment token stays in the browser — this page never reads it.
 *
 *  Apple currently returns 404 for the reserved product ID until the listing is
 *  public. Keeping the stable product URL here means the badge and Safari's Smart
 *  App Banner begin working automatically when App Store Connect publishes it. */
function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F6F1E6">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}">
<title>Join your friend on German Vocabulary</title>
<style>
:root {
  color-scheme: light;
  --cream: #F6F1E6;
  --cream-deep: #ECE4D3;
  --red: #C23A2F;
  --ink: #1A1A1A;
  --muted: #6D655B;
  --paper: #FFFCF6;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--cream); }
body {
  min-height: 100vh;
  min-height: 100svh;
  margin: 0;
  padding: clamp(1rem, 5vw, 3rem);
  display: grid;
  place-items: center;
  overflow-x: hidden;
  color: var(--ink);
  background:
    radial-gradient(circle at 12% 10%, rgba(194, 58, 47, .11), transparent 27rem),
    radial-gradient(circle at 92% 92%, rgba(204, 153, 28, .12), transparent 24rem),
    var(--cream);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
.card {
  position: relative;
  width: min(100%, 32rem);
  padding: clamp(1.5rem, 6vw, 2.6rem);
  overflow: hidden;
  text-align: center;
  background: var(--paper);
  border: 1px solid rgba(122, 113, 101, .18);
  border-radius: 1.75rem;
  box-shadow: 0 1.4rem 4rem rgba(61, 46, 35, .13);
}
.card::before {
  position: absolute;
  inset: 0 0 auto;
  height: .42rem;
  content: "";
  background: var(--red);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: .65rem;
  margin: .1rem auto 1.7rem;
  font-size: .94rem;
  font-weight: 700;
  letter-spacing: -.01em;
}
.brand-mark {
  width: 2.15rem;
  height: 2.15rem;
  display: grid;
  place-items: center;
  color: white;
  background: var(--red);
  border-radius: .72rem;
  box-shadow: .18rem .18rem 0 var(--cream-deep);
  font-family: Georgia, serif;
  font-size: 1.1rem;
  font-weight: 700;
}
.eyebrow {
  margin: 0 0 .7rem;
  color: var(--red);
  font-size: .76rem;
  font-weight: 800;
  letter-spacing: .13em;
}
h1 {
  max-width: 12em;
  margin: 0 auto .85rem;
  font-size: clamp(1.8rem, 7vw, 2.55rem);
  line-height: 1.08;
  letter-spacing: -.045em;
}
.intro {
  max-width: 27rem;
  margin: 0 auto 1.65rem;
  color: var(--muted);
  font-size: 1.04rem;
}
.app-store-link {
  display: block;
  width: fit-content;
  margin: 0 auto;
  padding: .35rem;
  border-radius: .8rem;
}
.app-store-link:focus-visible {
  outline: .2rem solid var(--red);
  outline-offset: .22rem;
}
.app-store-link svg {
  display: block;
  width: 11.25rem;
  height: auto;
}
.next-step {
  margin: 1.6rem 0 0;
  padding: 1rem 1.1rem;
  color: var(--muted);
  background: var(--cream);
  border: 1px solid var(--cream-deep);
  border-radius: 1rem;
  font-size: .94rem;
}
.next-step strong { color: var(--ink); }
.privacy {
  margin: 1.1rem 0 0;
  color: var(--muted);
  font-size: .78rem;
}
.privacy::before {
  color: var(--red);
  content: "●";
  margin-right: .45rem;
}
.legal {
  max-width: 28rem;
  margin: .8rem auto 0;
  color: var(--muted);
  font-size: .64rem;
  line-height: 1.35;
}
@media (max-width: 24rem) {
  body { padding: .75rem; }
  .card { padding: 1.45rem 1.15rem; border-radius: 1.35rem; }
  .brand { margin-bottom: 1.35rem; }
}
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">de</span>
    <span>German Vocabulary</span>
  </div>
  <p class="eyebrow">LEARN TOGETHER</p>
  <h1>A friend invited you to learn German together.</h1>
  <p class="intro">Install German Vocabulary on your iPhone or iPad, then open the original invite link again to connect.</p>
  <a class="app-store-link" href="${APP_STORE_PRODUCT_URL}" rel="noreferrer"
     aria-label="Download German Vocabulary on the App Store">
    ${APP_STORE_BADGE_SVG}
  </a>
  <p class="next-step"><strong>Already installed?</strong><br>Open the original invite link again and it will continue in the app.</p>
  <p class="privacy">Private invite · works once · expires after 30 days</p>
  <p class="legal">Apple and the Apple logo are trademarks of Apple Inc., registered in the U.S. and other countries and regions. App Store is a service mark of Apple Inc.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

/** Idempotency-wrapped mutation: body read once, canonical text keys the record. */
function mutation(
  route: string,
  run: (body: Record<string, unknown>, env: Env, ctx: SessionContext) => Promise<{ code: ErrorCode; data?: unknown }>,
): Handler {
  return async (request, env, requestId, ctx) => {
    let bodyText: string;
    try { bodyText = await request.text(); } catch { return envelope(requestId, "SCHEMA_INVALID"); }
    if (bodyText.length > 4096) return envelope(requestId, "SCHEMA_INVALID");
    let body: Record<string, unknown>;
    try { body = JSON.parse(bodyText || "{}"); } catch { return envelope(requestId, "SCHEMA_INVALID"); }
    const result = await withIdempotency(request, env, ctx!, route, bodyText, () => run(body, env, ctx!));
    return envelope(requestId, result.code, result.data);
  };
}

function fromResult(requestId: string, result: { code: ErrorCode; data?: unknown }): Response {
  return envelope(requestId, result.code, result.data);
}

// R7 verifies its own dual principal; R17's auth IS invite-token possession;
// R11's auth IS the deletion-status capability hash (works after session death).
const SELF_AUTHORIZING = new Set(["R7", "R17", "R11"]);

// --- auth guard (default-deny; capability/inviteToken levels land with their routes) --

async function authorize(
  route: RouteSpec, request: Request, env: Env,
): Promise<{ refusal: ErrorCode | null; ctx: SessionContext | null }> {
  if (SELF_AUTHORIZING.has(route.id)) return { refusal: null, ctx: null };
  switch (route.auth) {
    case "public":
      return { refusal: null, ctx: null };
    case "session": {
      // No device-attestation level (owner decision 2026-07-26 — IDENT-7 revised).
      // The former `sessionIntegrity` tier demanded an App Attest assertion the
      // client could never produce, so it denied every write on real hardware; and
      // even working, it would have spent DeviceCheck rate limit on /publish, which
      // runs at launch, foreground and session end. Abuse control is server-side:
      // session auth, per-route quotas, idempotency keys, relationship generations
      // and the publish envelope. Reintroducing attestation means adding the tier
      // back here TOGETHER with the client safeguards the requirements now specify.
      const session = await verifySession(request, env);
      if (!session.ok) return { refusal: session.code, ctx: null };
      return { refusal: null, ctx: session.ctx };
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
      // Invite web surface (owner 2026-07-25: learn-languages.app/german/join#<token>):
      // the landing page for the not-yet-installed case and the Universal Links
      // association file. Static, no third-party bytes, token never leaves the
      // fragment (FRIEND-1b). Served on every env; prod reaches it via the zone route.
      if (request.method === "GET" && url.pathname === "/german/join") {
        return landingPage();
      }
      if (request.method === "GET" && url.pathname === "/.well-known/apple-app-site-association") {
        return new Response(JSON.stringify({
          applinks: { apps: [], details: [{
            appIDs: [`${env.APP_TEAM_ID ?? "3VF33Y593F"}.${env.APP_BUNDLE_ID}`],
            components: [{ "/": "/german/join", comment: "leaderboard invite" }],
          }] },
        }), { headers: { "content-type": "application/json" } });
      }
      if (!url.pathname.startsWith(BASE)) return envelope(requestId, "NOT_FOUND");
      const route = ROUTES.find((r) => r.path === url.pathname && r.method === request.method);
      if (!route) return envelope(requestId, "NOT_FOUND");

      // Contract-declared body policy, enforced generically from the route table
      // (the single source): a wrong content type or a Content-Length past the
      // route's ceiling is refused before auth or handler work. The byte-exact
      // recheck still happens in the body-reading handlers (publish 1 MiB scan,
      // social writes 4 KiB) — this is the cheap header-level first line.
      if (route.method !== "GET") {
        const declared = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (route.contentTypes.length > 0 && declared && !route.contentTypes.includes(declared)) {
          return envelope(requestId, "SCHEMA_INVALID");
        }
        if (route.bodyLimit > 0 && Number(request.headers.get("content-length") ?? 0) > route.bodyLimit) {
          return envelope(requestId, "SCHEMA_INVALID");
        }
      }

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

  // Queue-less v1 (LB3-NFR-1b): the cron IS the outbox dispatcher — it drains
  // due erasure jobs (idempotent saga steps, exponential backoff, loud when
  // stuck) and runs the bounded cleanup sweeps.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await runOutboxTick(env);
    } catch (error) {
      console.error(JSON.stringify({ cron: "tick-failed", env: env.ENV_NAME, error: String(error) }));
    }
  },
} satisfies ExportedHandler<Env>;
