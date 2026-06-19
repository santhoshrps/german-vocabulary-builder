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

function decodeItem(bytes: Uint8Array, view: DataView, pos: number): DecodeResult {
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
      return { value: bytes.slice(next, next + len), next: next + len };
    }
    case 3: {
      // text string
      const { val: len, next } = readUint(view, ai, pos);
      const str = new TextDecoder().decode(bytes.slice(next, next + len));
      return { value: str, next: next + len };
    }
    case 4: {
      // array
      const { val: len, next } = readUint(view, ai, pos);
      let p = next;
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const r = decodeItem(bytes, view, p);
        arr.push(r.value);
        p = r.next;
      }
      return { value: arr, next: p };
    }
    case 5: {
      // map
      const { val: len, next } = readUint(view, ai, pos);
      let p = next;
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < len; i++) {
        const k = decodeItem(bytes, view, p);
        const v = decodeItem(bytes, view, k.next);
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
  return decodeItem(bytes, view, 0).value;
}
