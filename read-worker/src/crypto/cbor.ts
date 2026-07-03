// Minimal CBOR decoder — only the subset App Attest uses:
// unsigned/negative ints, byte strings, text strings, arrays, and maps.
// Not a general-purpose CBOR implementation.

interface DecodeResult {
  value: unknown;
  next: number;
}

function readUint(view: DataView, ai: number, pos: number): { val: number; next: number } {
  if (ai < 24) return { val: ai, next: pos };
  if (ai === 24) return { val: view.getUint8(pos), next: pos + 1 };
  if (ai === 25) return { val: view.getUint16(pos), next: pos + 2 };
  if (ai === 26) return { val: view.getUint32(pos), next: pos + 4 };
  if (ai === 27) {
    // 64-bit: JS numbers are safe up to 2^53; App Attest lengths never exceed that.
    const hi = view.getUint32(pos);
    const lo = view.getUint32(pos + 4);
    return { val: hi * 2 ** 32 + lo, next: pos + 8 };
  }
  throw new Error("cbor: unsupported length encoding");
}

// Nesting bound: App Attest objects are ~3 levels deep; anything deeper is hostile input
// aiming at stack exhaustion.
const MAX_DEPTH = 16;

// Every declared length is validated against the REMAINING input before any allocation or
// loop: a crafted attestation claiming a 2^40-element array (or a string longer than the
// buffer) must fail immediately, not burn CPU until an out-of-bounds read finally throws.
function checkLength(len: number, remaining: number, what: string): void {
  // Each array/map element and each string byte occupies ≥ 1 input byte, so a length can
  // never legitimately exceed what's left of the buffer.
  if (!Number.isSafeInteger(len) || len < 0 || len > remaining) {
    throw new Error(`cbor: ${what} length ${len} exceeds input`);
  }
}

function decodeItem(bytes: Uint8Array, view: DataView, pos: number, depth: number): DecodeResult {
  if (depth > MAX_DEPTH) throw new Error("cbor: nesting too deep");
  const initial = view.getUint8(pos);
  const major = initial >> 5;
  const ai = initial & 0x1f;
  pos += 1;

  switch (major) {
    case 0: {
      // unsigned int
      const { val, next } = readUint(view, ai, pos);
      return { value: val, next };
    }
    case 1: {
      // negative int
      const { val, next } = readUint(view, ai, pos);
      return { value: -1 - val, next };
    }
    case 2: {
      // byte string
      const { val: len, next } = readUint(view, ai, pos);
      checkLength(len, bytes.length - next, "byte string");
      return { value: bytes.slice(next, next + len), next: next + len };
    }
    case 3: {
      // text string
      const { val: len, next } = readUint(view, ai, pos);
      checkLength(len, bytes.length - next, "text string");
      const str = new TextDecoder().decode(bytes.slice(next, next + len));
      return { value: str, next: next + len };
    }
    case 4: {
      // array
      const { val: len, next } = readUint(view, ai, pos);
      checkLength(len, bytes.length - next, "array");
      let p = next;
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const r = decodeItem(bytes, view, p, depth + 1);
        arr.push(r.value);
        p = r.next;
      }
      return { value: arr, next: p };
    }
    case 5: {
      // map
      const { val: len, next } = readUint(view, ai, pos);
      // A map entry is ≥ 2 bytes (key + value); halve the remaining bound accordingly.
      checkLength(len, (bytes.length - next) >> 1, "map");
      let p = next;
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < len; i++) {
        const k = decodeItem(bytes, view, p, depth + 1);
        const v = decodeItem(bytes, view, k.next, depth + 1);
        map.set(k.value, v.value);
        p = v.next;
      }
      return { value: map, next: p };
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

export function decodeCbor(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return decodeItem(bytes, view, 0, 0).value;
}
