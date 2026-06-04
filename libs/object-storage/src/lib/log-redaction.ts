import { createHash } from 'node:crypto';

// A8-3a — log-side identifier redaction (the Gate-5 review-item-3
// pre-commit change, ratified by the Commit Plan §4).
//
// The S3 key PATH keeps the real talent_record_id (IAM prefix-scoping
// + the Postgres round-trip need it). The access-LOG emits a HASHED
// form — preserving group-by-talent correlation across log lines
// without spilling the raw UUID into log aggregators (which retain
// payloads beyond the operational lifetime of the underlying record).
//
// Why 16 hex chars (8 bytes): ~10^19 buckets, more than enough
// collision-safety for the correlation use case; not reversible to the
// raw UUID without the input domain (which is itself only ~10^38). The
// short prefix keeps log lines compact.
//
// "log line carries a hashed id" is the floor; the storage_key field
// (operationally needed for object-side debugging) is left as-is — its
// embedded identifiers are structural artifacts of the S3 path, not a
// labeled identifying field a log aggregator would index for PII.

export function hashIdentifierForLog(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}
