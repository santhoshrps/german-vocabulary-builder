// Closed wire contract for the Cloudflare Queue used by the leaderboard.
//
// Queue messages are deliberately only opaque D1 references. The authoritative
// job kind, deletion subject and mutable state remain in D1 and are reloaded by
// the consumer. This keeps Queue/DLQ retention from becoming a second social
// data store and makes duplicate delivery harmless.

import { hashedSubject } from "./crypto";

export const OUTBOX_MESSAGE_VERSION = 1 as const;
export const OUTBOX_ACTIVE_CAP = 2_000;
export const OUTBOX_ERASURE_ACTIVE_CAP = 1_900;
export const OUTBOX_CLEANUP_ACTIVE_CAP = 100;
export const OUTBOX_DISPATCH_BATCH = 10;
export const OUTBOX_COMPLETED_RETENTION_MS = 7 * 86_400_000;

export type OutboxKind = "erasure" | "cleanup";

export interface SocialOutboxMessage {
  v: typeof OUTBOX_MESSAGE_VERSION;
  env: string;
  app: string;
  dedupId: string;
  kind: OutboxKind;
}

const MESSAGE_KEYS = ["app", "dedupId", "env", "kind", "v"] as const;
const ERASURE_DEDUP = /^erasure:[a-f0-9]{64}$/;
const CLEANUP_DEDUP = /^cleanup:[0-9]{1,16}$/;
const SCOPE = /^[a-z][a-z0-9-]{0,31}$/;

/** Stable, opaque per-profile identifier. The player id never enters Queue or logs. */
export async function erasureDedupId(identitySecret: string, playerId: string): Promise<string> {
  return `erasure:${await hashedSubject(identitySecret, "outbox-erasure", playerId)}`;
}

/** One cleanup job per 15-minute UTC bucket; replay never crosses incarnations. */
export function cleanupDedupId(now: number): string {
  return `cleanup:${Math.floor(now / (15 * 60_000))}`;
}

export function makeOutboxMessage(
  env: string, app: string, dedupId: string, kind: OutboxKind,
): SocialOutboxMessage {
  return { v: OUTBOX_MESSAGE_VERSION, env, app, dedupId, kind };
}

/** Strict and closed: additive fields require a message-version change. */
export function parseOutboxMessage(value: unknown): SocialOutboxMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== MESSAGE_KEYS.length ||
      !keys.every((key, index) => key === MESSAGE_KEYS[index])) return null;
  if (record.v !== OUTBOX_MESSAGE_VERSION ||
      typeof record.env !== "string" || !SCOPE.test(record.env) ||
      typeof record.app !== "string" || !SCOPE.test(record.app) ||
      (record.kind !== "erasure" && record.kind !== "cleanup") ||
      typeof record.dedupId !== "string") return null;
  if (record.kind === "erasure" && !ERASURE_DEDUP.test(record.dedupId)) return null;
  if (record.kind === "cleanup" && !CLEANUP_DEDUP.test(record.dedupId)) return null;
  return {
    v: OUTBOX_MESSAGE_VERSION,
    env: record.env,
    app: record.app,
    dedupId: record.dedupId,
    kind: record.kind,
  };
}

/** Deterministic jitter prevents a restart herd without random or persisted state. */
export function retryDelaySeconds(dedupId: string, attempt: number): number {
  let seed = 0;
  for (let index = 0; index < dedupId.length; index++) {
    seed = ((seed * 33) ^ dedupId.charCodeAt(index)) >>> 0;
  }
  const boundedAttempt = Math.max(0, Math.min(attempt, 6));
  return Math.min(3_600, 30 * 2 ** boundedAttempt + seed % 17);
}
