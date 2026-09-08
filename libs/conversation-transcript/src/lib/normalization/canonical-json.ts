// CI-B4 — deterministic canonical JSON serialization for the normalized
// transcript artifact. The normalized artifact's SHA-256 is part of the
// evidence-integrity contract, so its byte layout MUST be stable and OWNED by
// this schema version: a normalized artifact hash must never change because a
// shared workspace utility changed. (An equivalent `hashCanonicalizedBody`
// lives in @aramo/common; B4 keeps a local, version-pinned serializer to avoid
// a cross-lib nx edge on this zero-dependency leaf and to freeze the byte
// contract to `conversation-transcript.normalized.v1`.)
//
// Rules (frozen for v1):
//   * object keys are sorted lexicographically (UTF-16 code-unit order, the
//     JS default for `Array.prototype.sort`), recursively;
//   * arrays preserve their given order (utterance ORDINAL order is semantic);
//   * `undefined` values and `undefined`-valued keys are dropped (absent means
//     absent — never serialized as null);
//   * `null` is preserved as `null` (callers must omit optional fields, not set
//     them to null, so hash stability holds);
//   * output is compact UTF-8 (no insignificant whitespace).

/** Recursively produce a value whose JSON.stringify is byte-deterministic. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** Deterministic compact JSON string for `value`. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Deterministic canonical UTF-8 bytes for `value` (what gets stored + hashed). */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalStringify(value), 'utf8');
}
