import { createHash } from 'node:crypto';

// Deterministic JSON canonicalization for the idempotency request hash.
// Sorts object keys recursively; arrays preserve order; undefined keys are
// dropped (JSON.stringify skips them anyway). Used so that two semantically
// identical requests produce identical hashes regardless of key ordering.
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    result[k] = canonicalize(obj[k]);
  }
  return result;
}

export function hashCanonicalizedBody(body: unknown): string {
  const canonical = JSON.stringify(canonicalize(body));
  return createHash('sha256').update(canonical).digest('hex');
}
