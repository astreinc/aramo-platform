import { createHash } from 'node:crypto';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 8 —
// recovery validation (pure core of the read-only ops script). For each artifact it
// fetches the object BY ITS RECORDED VERSION ID and verifies the SHA-256 of the bytes
// against the database row and, when present, the custody ledger event. It never
// writes anything.
//
// Retention and Purge directive (ebd41d99) W8 — a purged artifact (purged_at set) is
// PURGED when its recorded custody version is gone from S3, PURGE_INCOMPLETE (a failure)
// when that version can still be read. An artifact of an envelope whose queued purge is
// waiting on an unexpired Object Lock validates as usual and is reported
// PURGE_WAITING_LOCK. The evidence snapshot is never purged (LD-3) and is always checked.

export type ValidatedArtifactKind = 'EXECUTED_DOCUMENT' | 'EXECUTION_CERTIFICATE' | 'EVIDENCE';

export interface ArtifactCustodyRef {
  kind: ValidatedArtifactKind;
  artifact_id: string;
  tenant_id: string;
  envelope_id: string;
  /** The authoritative hash: the DB row's executed/certificate sha (evidence: the ledger's). */
  expected_sha256: string;
  custody_object_key: string | null;
  custody_version_id: string | null;
  custody_sha256: string | null;
  /** sha256 recorded in the custody ledger event, or null/undefined when no event exists. */
  ledger_sha256?: string | null;
  ledger_version_id?: string | null;
  /** Set once the artifact's bytes were purged (Retention and Purge W3). */
  purged_at?: Date | null;
  /** Set while the envelope's queued purge waits for an Object Lock to expire. */
  purge_waiting_until?: Date | null;
}

export type ValidationStatus =
  | 'OK'
  | 'MISSING_CUSTODY'
  | 'RECORD_MISMATCH'
  | 'LEDGER_MISMATCH'
  | 'FETCH_FAILED'
  | 'CONTENT_MISMATCH'
  | 'PURGED'
  | 'PURGE_INCOMPLETE'
  | 'PURGE_WAITING_LOCK';

/** The statuses that are not failures (exit 0). */
export const VALIDATION_PASS_STATUSES: ReadonlySet<ValidationStatus> = new Set<ValidationStatus>(['OK', 'PURGED', 'PURGE_WAITING_LOCK']);

export interface ValidationFinding {
  kind: ValidatedArtifactKind;
  artifact_id: string;
  envelope_id: string;
  status: ValidationStatus;
  object_key: string | null;
  version_id: string | null;
  detail?: string;
}

export interface ValidationReport {
  checked: number;
  ok: number;
  failures: number;
  by_status: Record<ValidationStatus, number>;
  findings: ValidationFinding[];
}

export interface VersionedObjectReader {
  getVersion(object_key: string, version_id: string): Promise<Buffer>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function validateArtifactCustody(refs: readonly ArtifactCustodyRef[], reader: VersionedObjectReader): Promise<ValidationReport> {
  const by_status: Record<ValidationStatus, number> = {
    OK: 0, MISSING_CUSTODY: 0, RECORD_MISMATCH: 0, LEDGER_MISMATCH: 0, FETCH_FAILED: 0, CONTENT_MISMATCH: 0,
    PURGED: 0, PURGE_INCOMPLETE: 0, PURGE_WAITING_LOCK: 0,
  };
  const findings: ValidationFinding[] = [];
  for (const ref of refs) {
    const base = { kind: ref.kind, artifact_id: ref.artifact_id, envelope_id: ref.envelope_id, object_key: ref.custody_object_key, version_id: ref.custody_version_id };
    const finding = await validateOne(ref, reader, base);
    by_status[finding.status] += 1;
    findings.push(finding);
  }
  const ok = findings.filter((f) => VALIDATION_PASS_STATUSES.has(f.status)).length;
  return { checked: refs.length, ok, failures: refs.length - ok, by_status, findings };
}

function isGone(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return name === 'NoSuchVersion' || name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

async function validateOne(
  ref: ArtifactCustodyRef,
  reader: VersionedObjectReader,
  base: Omit<ValidationFinding, 'status' | 'detail'>,
): Promise<ValidationFinding> {
  if (ref.purged_at !== undefined && ref.purged_at !== null) {
    // Nothing was ever stored, or the recorded version must be gone.
    if (ref.custody_object_key === null || ref.custody_version_id === null) return { ...base, status: 'PURGED' };
    try {
      await reader.getVersion(ref.custody_object_key, ref.custody_version_id);
    } catch (err) {
      if (isGone(err)) return { ...base, status: 'PURGED' };
      const name = (err as { name?: string } | null)?.name ?? 'Error';
      return { ...base, status: 'FETCH_FAILED', detail: `${name}: ${(err as Error).message}` };
    }
    return { ...base, status: 'PURGE_INCOMPLETE', detail: 'purged artifact version is still readable' };
  }
  const verified = await validateStored(ref, reader, base);
  if (verified.status === 'OK' && ref.purge_waiting_until !== undefined && ref.purge_waiting_until !== null) {
    return { ...verified, status: 'PURGE_WAITING_LOCK', detail: `queued purge waits for Object Lock until ${ref.purge_waiting_until.toISOString()}` };
  }
  return verified;
}

async function validateStored(
  ref: ArtifactCustodyRef,
  reader: VersionedObjectReader,
  base: Omit<ValidationFinding, 'status' | 'detail'>,
): Promise<ValidationFinding> {
  if (ref.custody_object_key === null || ref.custody_version_id === null || ref.custody_sha256 === null) {
    return { ...base, status: 'MISSING_CUSTODY' };
  }
  if (ref.custody_sha256 !== ref.expected_sha256) {
    return { ...base, status: 'RECORD_MISMATCH', detail: 'custody_sha256 differs from the artifact hash' };
  }
  if (ref.ledger_sha256 !== undefined && ref.ledger_sha256 !== null) {
    if (ref.ledger_sha256 !== ref.expected_sha256) return { ...base, status: 'LEDGER_MISMATCH', detail: 'ledger sha256 differs from the artifact hash' };
    if (ref.ledger_version_id !== undefined && ref.ledger_version_id !== null && ref.ledger_version_id !== ref.custody_version_id) {
      return { ...base, status: 'LEDGER_MISMATCH', detail: 'ledger version id differs from the custody version id' };
    }
  }
  let bytes: Buffer;
  try {
    bytes = await reader.getVersion(ref.custody_object_key, ref.custody_version_id);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? 'Error';
    return { ...base, status: 'FETCH_FAILED', detail: `${name}: ${(err as Error).message}` };
  }
  const actual = sha256Hex(bytes);
  if (actual !== ref.expected_sha256) return { ...base, status: 'CONTENT_MISMATCH', detail: `stored object sha256 ${actual}` };
  return { ...base, status: 'OK' };
}

// ── Assembling refs from DB rows + custody ledger events ──

export interface CustodyLedgerEvent {
  envelope_id: string;
  payload: unknown;
}

interface LedgerPayload {
  artifact_kind?: string;
  artifact_id?: string;
  object_key?: string;
  version_id?: string;
  sha256?: string;
  evidence?: { object_key?: string; version_id?: string; sha256?: string };
}

export function buildCustodyRefs(input: {
  executed: ReadonlyArray<{ id: string; tenant_id: string; envelope_id: string; executed_sha256: string; custody_object_key: string | null; custody_version_id: string | null; custody_sha256: string | null; purged_at?: Date | null }>;
  certificates: ReadonlyArray<{ id: string; tenant_id: string; envelope_id: string; certificate_sha256: string; custody_object_key: string | null; custody_version_id: string | null; custody_sha256: string | null; purged_at?: Date | null }>;
  events: ReadonlyArray<CustodyLedgerEvent>;
  /** envelope_id → purge_waiting_until, for queued purges waiting on an Object Lock. */
  purge_waiting?: ReadonlyMap<string, Date>;
}): ArtifactCustodyRef[] {
  const waiting = (envelope_id: string): { purge_waiting_until?: Date } => {
    const w = input.purge_waiting?.get(envelope_id);
    return w !== undefined ? { purge_waiting_until: w } : {};
  };
  const purged = (r: { purged_at?: Date | null }): { purged_at?: Date } => (r.purged_at !== undefined && r.purged_at !== null ? { purged_at: r.purged_at } : {});
  const byArtifact = new Map<string, LedgerPayload>();
  for (const e of input.events) {
    const p = (e.payload ?? {}) as LedgerPayload;
    if (typeof p.artifact_id === 'string') byArtifact.set(p.artifact_id, p);
  }
  const refs: ArtifactCustodyRef[] = [];
  for (const r of input.executed) {
    const l = byArtifact.get(r.id);
    refs.push({
      kind: 'EXECUTED_DOCUMENT', artifact_id: r.id, tenant_id: r.tenant_id, envelope_id: r.envelope_id, expected_sha256: r.executed_sha256,
      custody_object_key: r.custody_object_key, custody_version_id: r.custody_version_id, custody_sha256: r.custody_sha256,
      ledger_sha256: l?.sha256 ?? null, ledger_version_id: l?.version_id ?? null,
      ...purged(r), ...waiting(r.envelope_id),
    });
  }
  for (const r of input.certificates) {
    const l = byArtifact.get(r.id);
    refs.push({
      kind: 'EXECUTION_CERTIFICATE', artifact_id: r.id, tenant_id: r.tenant_id, envelope_id: r.envelope_id, expected_sha256: r.certificate_sha256,
      custody_object_key: r.custody_object_key, custody_version_id: r.custody_version_id, custody_sha256: r.custody_sha256,
      ledger_sha256: l?.sha256 ?? null, ledger_version_id: l?.version_id ?? null,
      ...purged(r), ...waiting(r.envelope_id),
    });
    const ev = l?.evidence;
    if (ev !== undefined && typeof ev.sha256 === 'string') {
      // The evidence snapshot has no DB row: the ledger is its only hash record.
      refs.push({
        kind: 'EVIDENCE', artifact_id: `${r.id}:evidence`, tenant_id: r.tenant_id, envelope_id: r.envelope_id, expected_sha256: ev.sha256,
        custody_object_key: ev.object_key ?? null, custody_version_id: ev.version_id ?? null, custody_sha256: ev.sha256,
        ...waiting(r.envelope_id),
      });
    }
  }
  return refs;
}
