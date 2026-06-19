import { Env } from "./env";
import { utf8, sha256, bytesToHex } from "./bytes";

export const TABLES = ["verbs", "nouns", "adverbs_adjectives"] as const;
export type TableName = (typeof TABLES)[number];

export function isTable(t: string): t is TableName {
  return (TABLES as readonly string[]).includes(t);
}

const ROWS_PER_REQUEST_CAP = 200;

// ---- Dataset version --------------------------------------------------------
// Prefer an explicit value in meta.dataset_version (bumped by the write worker).
// Otherwise derive one from per-table COUNT(*) + MAX(updated_at): COUNT reflects
// deletions, MAX(updated_at) reflects inserts/updates — so any change moves it.
export async function getVersion(env: Env): Promise<string> {
  const explicit = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'dataset_version'"
  ).first<{ value: string }>().catch(() => null);
  if (explicit?.value) return explicit.value;

  const parts: string[] = [];
  for (const t of TABLES) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM ${t}`
    ).first<{ c: number; m: string }>();
    parts.push(`${t}:${row?.c ?? 0}:${row?.m ?? ""}`);
  }
  const hash = bytesToHex(await sha256(utf8(parts.join("|"))));
  return hash.slice(0, 16);
}

// ---- Manifest ---------------------------------------------------------------
// { table: { id: content_hash } } for client-side reconciliation (incl. deletes).
export async function getManifest(env: Env): Promise<Record<string, Record<string, string>>> {
  const manifest: Record<string, Record<string, string>> = {};
  for (const t of TABLES) {
    const res = await env.DB.prepare(`SELECT id, content_hash FROM ${t}`)
      .all<{ id: string; content_hash: string }>();
    const map: Record<string, string> = {};
    for (const r of res.results) map[r.id] = r.content_hash;
    manifest[t] = map;
  }
  return manifest;
}

// ---- Rows -------------------------------------------------------------------
// Full rows for specific ids (the changed set from a manifest diff).
export async function getRows(env: Env, table: TableName, ids: string[]): Promise<unknown[]> {
  const capped = ids.slice(0, ROWS_PER_REQUEST_CAP);
  if (capped.length === 0) return [];
  const placeholders = capped.map(() => "?").join(", ");
  const res = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id IN (${placeholders})`
  ).bind(...capped).all();
  return res.results;
}

export const ROWS_CAP = ROWS_PER_REQUEST_CAP;

// ---- Snapshot ---------------------------------------------------------------
// Full dataset as NDJSON (one row per line). Cloudflare compresses the response;
// the phone streams + inserts line-by-line without buffering it all in memory.
export async function buildSnapshotNdjson(env: Env): Promise<string> {
  const lines: string[] = [];
  for (const t of TABLES) {
    const res = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    for (const row of res.results) {
      lines.push(JSON.stringify({ t, row }));
    }
  }
  return lines.join("\n") + "\n";
}
