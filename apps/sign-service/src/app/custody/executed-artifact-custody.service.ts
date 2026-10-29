import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  EsignService,
  SignArtifactCustodyRepository,
  type CustodyArtifactKind,
  type ExecutedArtifactCustodyPort,
  type SignedEvidenceManifest,
} from '@aramo/sign';

import { SIGN_ARTIFACT_RETENTION_MODE, signCertificateKey, signEvidenceKey, signExecutedKey } from './sign-artifact-storage.config.js';
import { SignArtifactStore, hexToBase64, sha256Hex, type StoredArtifact } from './sign-artifact-store.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 7 —
// completion custody. After the executed and certificate rows exist (post-commit), each
// executed PDF, the certificate and an evidence snapshot are uploaded to the dedicated
// Sign bucket; the row's custody_* columns are then set NULL to value (only while still
// NULL) and a ledger event records key, version id and SHA-256 in the same transaction.
// PostgreSQL stays authoritative; the *_bytes columns are kept.
//
// Failure never fails completion: the columns stay NULL and the reconcile job retries.
// Idempotent: an object already present under the (content-addressed) key with a
// matching S3 SHA-256 checksum is adopted (its version id recorded) instead of rewritten.
// The evidence snapshot is captured with the certificate's custody, before any custody
// event of the run is appended; it is whatever the current evidence manifest builder
// returns (manifest logic is not owned here).

export interface EnvelopeCustodyOutcome {
  recorded: number;
  adopted: number;
  failed: number;
}

export interface ReconcileReport extends EnvelopeCustodyOutcome {
  envelopes: number;
}

export const CUSTODY_RECONCILE_MAX_ENVELOPES = 25;
// Rows younger than this are left to the inline completion upload.
export const CUSTODY_RECONCILE_MIN_AGE_MS = 120_000;

interface CustodyRecord {
  object_key: string;
  version_id: string;
  sha256: string;
  retain_until: Date | null;
  adopted: boolean;
}

// One-line error text for the log (driver errors are multi-line).
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}

@Injectable()
export class ExecutedArtifactCustodyService implements ExecutedArtifactCustodyPort {
  private readonly log = new Logger('SignArtifactCustody');

  constructor(
    private readonly rows: SignArtifactCustodyRepository,
    private readonly store: SignArtifactStore,
    // EsignService (the evidence manifest builder) depends on the execution producer,
    // which depends on this service: resolved lazily to keep the graph acyclic.
    private readonly moduleRef: ModuleRef,
  ) {}

  get enabled(): boolean {
    return this.store.enabled;
  }

  async recordCompletion(tenant_id: string, envelope_id: string): Promise<void> {
    if (!this.store.enabled) return;
    try {
      const outcome = await this.custodyForEnvelope(tenant_id, envelope_id);
      if (outcome.failed > 0) {
        this.log.warn(`sign_artifact_custody.completion_failed failed=${outcome.failed} recorded=${outcome.recorded} envelope_id=${envelope_id}`);
      }
    } catch (err) {
      this.log.warn(`sign_artifact_custody.completion_failed envelope_id=${envelope_id} error=${errText(err)}`);
    }
  }

  /** Records custody for every artifact of the envelope whose custody is still NULL. */
  async custodyForEnvelope(tenant_id: string, envelope_id: string, now: Date = new Date()): Promise<EnvelopeCustodyOutcome> {
    const outcome: EnvelopeCustodyOutcome = { recorded: 0, adopted: 0, failed: 0 };
    if (!this.store.enabled) return outcome;

    // The evidence snapshot is captured FIRST, before this run appends any custody
    // event, so on the completion path its event-chain hash is the completion-time
    // terminal hash (the one the certificate prints). Certificate custody (and its
    // ledger event) is committed only once the evidence object is stored, so a NULL
    // certificate custody always means "evidence not captured yet" for reconcile.
    const cert = await this.rows.pendingCertificate(tenant_id, envelope_id);
    let evidence: (CustodyRecord & { byte_size: number }) | null = null;
    let evidenceError: unknown = null;
    if (cert !== null) {
      try {
        evidence = await this.storeEvidence(tenant_id, envelope_id, cert, now);
      } catch (err) {
        evidenceError = err;
      }
    }

    const executed = await this.rows.pendingExecuted(tenant_id, envelope_id);
    for (const row of executed) {
      try {
        const sha = this.verifiedSha(row.executed_bytes, row.executed_sha256);
        const key = signExecutedKey(tenant_id, envelope_id, row.envelope_document_id, sha);
        const stored = await this.storeContentAddressed(key, Buffer.from(row.executed_bytes), 'application/pdf', sha, now);
        const set = await this.commitCustody('EXECUTED_DOCUMENT', { id: row.id, tenant_id, envelope_id, envelope_document_id: row.envelope_document_id, byte_size: row.byte_size }, stored, now);
        if (set) this.tally(outcome, stored);
      } catch (err) {
        outcome.failed += 1;
        this.log.warn(`sign_artifact_custody.upload_failed kind=EXECUTED_DOCUMENT artifact_id=${row.id} error=${errText(err)}`);
      }
    }

    if (cert !== null) {
      try {
        if (evidence === null) throw evidenceError ?? new Error('evidence snapshot not stored');
        const sha = this.verifiedSha(cert.certificate_bytes, cert.certificate_sha256);
        const key = signCertificateKey(tenant_id, envelope_id, sha);
        const stored = await this.storeContentAddressed(key, Buffer.from(cert.certificate_bytes), 'application/pdf', sha, now);
        const set = await this.commitCustody('EXECUTION_CERTIFICATE', { id: cert.id, tenant_id, envelope_id, byte_size: cert.byte_size }, stored, now, evidence);
        if (set) this.tally(outcome, stored);
      } catch (err) {
        outcome.failed += 1;
        this.log.warn(`sign_artifact_custody.upload_failed kind=EXECUTION_CERTIFICATE artifact_id=${cert.id} error=${errText(err)}`);
      }
    }
    return outcome;
  }

  /**
   * Reconcile: retry custody for envelopes with a NULL-custody executed or certificate
   * row older than the minimum age. Bounded per run; logs one summary line (and a
   * failure line when any artifact failed).
   */
  async reconcile(opts: { now?: Date; maxEnvelopes?: number } = {}): Promise<ReconcileReport> {
    const report: ReconcileReport = { envelopes: 0, recorded: 0, adopted: 0, failed: 0 };
    if (!this.store.enabled) return report;
    const now = opts.now ?? new Date();
    const max = opts.maxEnvelopes ?? CUSTODY_RECONCILE_MAX_ENVELOPES;
    const cutoff = new Date(now.getTime() - CUSTODY_RECONCILE_MIN_AGE_MS);
    const pending = await this.rows.pendingEnvelopes(cutoff, max);
    for (const { tenant_id, envelope_id } of pending) {
      report.envelopes += 1;
      try {
        const o = await this.custodyForEnvelope(tenant_id, envelope_id, now);
        report.recorded += o.recorded;
        report.adopted += o.adopted;
        report.failed += o.failed;
      } catch (err) {
        report.failed += 1;
        this.log.warn(`sign_artifact_custody.reconcile_envelope_failed envelope_id=${envelope_id} error=${errText(err)}`);
      }
    }
    if (report.envelopes > 0) {
      const line = `sign_artifact_custody.reconcile envelopes=${report.envelopes} recorded=${report.recorded} adopted=${report.adopted} failed=${report.failed}`;
      if (report.failed > 0) this.log.warn(line);
      else this.log.log(line);
    }
    return report;
  }

  private tally(outcome: EnvelopeCustodyOutcome, stored: CustodyRecord): void {
    outcome.recorded += 1;
    if (stored.adopted) outcome.adopted += 1;
  }

  // The bytes leaving PostgreSQL must still match the row's recorded hash.
  private verifiedSha(bytes: Uint8Array, recorded: string): string {
    const actual = sha256Hex(bytes);
    if (actual !== recorded) throw new Error('artifact bytes do not match the recorded sha256; custody refused');
    return actual;
  }

  private async storeContentAddressed(key: string, body: Buffer, content_type: string, sha256: string, now: Date): Promise<CustodyRecord> {
    const existing = await this.store.head(key);
    if (existing !== null && existing.version_id !== null && existing.checksum_sha256 === hexToBase64(sha256)) {
      return { object_key: key, version_id: existing.version_id, sha256, retain_until: existing.retain_until, adopted: true };
    }
    const put: StoredArtifact = await this.store.putArtifact({ key, body, content_type, sha256, now });
    return { object_key: key, version_id: put.version_id, sha256, retain_until: put.retain_until, adopted: false };
  }

  private async storeEvidence(
    tenant_id: string,
    envelope_id: string,
    cert: { id: string; certificate_sha256: string; byte_size: number },
    now: Date,
  ): Promise<CustodyRecord & { byte_size: number }> {
    const esign = this.moduleRef.get(EsignService, { strict: false });
    const evidence: SignedEvidenceManifest = await esign.evidenceManifest(tenant_id, envelope_id);
    const executed = await this.rows.executedSummaries(tenant_id, envelope_id);
    const snapshot = {
      schema: 'aramo.sign.evidence-snapshot.v1',
      tenant_id,
      envelope_id,
      captured_at: now.toISOString(),
      evidence,
      artifacts: {
        executed_documents: executed.map((e) => ({
          artifact_id: e.id,
          envelope_document_id: e.envelope_document_id,
          source_sha256: e.source_sha256,
          executed_sha256: e.executed_sha256,
          byte_size: e.byte_size,
        })),
        certificate: { artifact_id: cert.id, certificate_sha256: cert.certificate_sha256, byte_size: cert.byte_size },
      },
    };
    const body = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const sha = sha256Hex(body);
    const stored = await this.store.putArtifact({ key: signEvidenceKey(tenant_id, envelope_id, sha), body, content_type: 'application/json', sha256: sha, now });
    return { object_key: signEvidenceKey(tenant_id, envelope_id, sha), version_id: stored.version_id, sha256: sha, retain_until: stored.retain_until, adopted: false, byte_size: body.byteLength };
  }

  /**
   * Sets the custody columns NULL to value (a no-op when another writer got there
   * first) and, only when this call set them, appends the ledger event — one
   * transaction, under the envelope row lock (SignArtifactCustodyRepository).
   */
  private async commitCustody(
    kind: CustodyArtifactKind,
    artifact: { id: string; tenant_id: string; envelope_id: string; envelope_document_id?: string; byte_size: number },
    stored: CustodyRecord,
    now: Date,
    evidence?: CustodyRecord & { byte_size: number },
  ): Promise<boolean> {
    return this.rows.recordCustody({
      kind,
      artifact_id: artifact.id,
      tenant_id: artifact.tenant_id,
      envelope_id: artifact.envelope_id,
      columns: {
        custody_object_key: stored.object_key,
        custody_version_id: stored.version_id,
        custody_sha256: stored.sha256,
        custody_retain_until: stored.retain_until,
        custody_stored_at: now,
      },
      payload: {
        artifact_kind: kind,
        artifact_id: artifact.id,
        ...(artifact.envelope_document_id !== undefined ? { envelope_document_id: artifact.envelope_document_id } : {}),
        bucket: this.store.bucket,
        object_key: stored.object_key,
        version_id: stored.version_id,
        sha256: stored.sha256,
        byte_size: artifact.byte_size,
        retention_mode: stored.retain_until !== null ? SIGN_ARTIFACT_RETENTION_MODE : null,
        retain_until: stored.retain_until !== null ? stored.retain_until.toISOString() : null,
        ...(evidence !== undefined
          ? {
              evidence: {
                object_key: evidence.object_key,
                version_id: evidence.version_id,
                sha256: evidence.sha256,
                byte_size: evidence.byte_size,
                retain_until: evidence.retain_until !== null ? evidence.retain_until.toISOString() : null,
              },
            }
          : {}),
      },
    });
  }
}
