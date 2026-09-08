// CI-B4 — SHA-256 helpers. Integrity metadata ONLY (directive §hash-integrity).
// Never hashes anything that is logged; callers hash bytes/opaque identity, not
// content that is emitted.

import { createHash } from 'node:crypto';

/** Hex SHA-256 of raw bytes — computed from the EXACT bytes that get stored. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hex SHA-256 of a UTF-8 string (for stable id derivation from canonical inputs). */
export function sha256HexUtf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
