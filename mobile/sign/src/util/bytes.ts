// Dependency-free byte helpers (base64, base64url, UTF-8). Hermes and Node both run
// these unchanged, so crypto and storage code is testable in jest without polyfills.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP[ALPHABET.charAt(i)] = i;

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63) + '==';
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      '=';
  }
  return out;
}

export function base64Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = LOOKUP[ch];
    if (v === undefined) throw new Error('invalid base64');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** RFC 4648 §5 base64url without padding (PKCE, state, nonce). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] ?? 0;
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if (b >= 0xf0) {
      cp =
        ((b & 7) << 18) |
        (((bytes[i + 1] ?? 0) & 63) << 12) |
        (((bytes[i + 2] ?? 0) & 63) << 6) |
        ((bytes[i + 3] ?? 0) & 63);
      i += 4;
    } else if (b >= 0xe0) {
      cp = ((b & 15) << 12) | (((bytes[i + 1] ?? 0) & 63) << 6) | ((bytes[i + 2] ?? 0) & 63);
      i += 3;
    } else {
      cp = ((b & 31) << 6) | ((bytes[i + 1] ?? 0) & 63);
      i += 2;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}
