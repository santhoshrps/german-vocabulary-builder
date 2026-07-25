// D1 BLOB columns come back as ArrayBuffer on the remote runtime but as plain
// number[] from local D1 — one decoder, used everywhere, so a runtime
// difference can never silently read a stored blob as empty (found by the
// integration harness: replay publishes reported changed=true because stored
// registers decoded as empty locally).
export function blobBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return value.byteLength ? new Uint8Array(value) : null;
  if (ArrayBuffer.isView(value)) return value.byteLength ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  if (Array.isArray(value)) return value.length ? new Uint8Array(value) : null;
  return null;
}

export function blobText(value: unknown): string | null {
  const bytes = blobBytes(value);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
