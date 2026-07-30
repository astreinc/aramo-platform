import { createHash } from 'node:crypto';

// Canonical serialization + SHA-256 integrity checksum for a stored policy
// definition (ADR-0024 §D17b `checksum`).
//
// The definition is persisted as JSONB. Postgres JSONB does NOT preserve
// object key order and may re-serialize on read, so a byte-for-byte
// `JSON.stringify` of the round-tripped value would not match the stored
// hash. Canonicalization removes that ambiguity: object keys are sorted
// recursively (array order is preserved — it is semantically significant
// for a policy's `rules`), so the checksum depends only on the definition's
// content, not on its incidental serialization order. That is what makes a
// tampered row detectable: an altered value changes the canonical form and
// therefore the recomputed hash, while a mere key-order shuffle by JSONB
// does not.

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const members = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`);
  return `{${members.join(',')}}`;
}

/** Deterministic canonical string form of a definition (sorted keys). */
export function canonicalSerialize(definition: unknown): string {
  return canonicalize(definition);
}

/** SHA-256 hex checksum over the canonical serialization of a definition. */
export function computeChecksum(definition: unknown): string {
  return createHash('sha256').update(canonicalSerialize(definition)).digest('hex');
}

/** True when the stored checksum matches a freshly computed one. */
export function checksumMatches(definition: unknown, storedChecksum: string): boolean {
  return computeChecksum(definition) === storedChecksum;
}
