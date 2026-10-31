import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE } from './ports/executed-artifact-custody.port.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 7 —
// the database side of executed-artifact custody: which artifacts still lack custody,
// and the one write: set custody_* NULL to value (never over a recorded value) and
// append the custody ledger event in the same transaction, under the envelope row lock
// that serializes the hash chain. Reads for recovery validation run READ ONLY.

export type CustodyArtifactKind = 'EXECUTED_DOCUMENT' | 'EXECUTION_CERTIFICATE';

export interface CustodyColumns {
  custody_object_key: string;
  custody_version_id: string;
  custody_sha256: string;
  custody_retain_until: Date | null;
  custody_stored_at: Date;
}

export interface PendingExecutedArtifact {
  id: string;
  envelope_document_id: string;
  executed_sha256: string;
  byte_size: number;
  executed_bytes: Uint8Array;
}

export interface PendingCertificateArtifact {
  id: string;
  certificate_sha256: string;
  byte_size: number;
  certificate_bytes: Uint8Array;
}

export interface ExecutedArtifactSummary {
  id: string;
  envelope_document_id: string;
  source_sha256: string;
  executed_sha256: string;
  byte_size: number;
}

export interface CustodyValidationRows {
  executed: Array<{ id: string; tenant_id: string; envelope_id: string; executed_sha256: string; custody_object_key: string | null; custody_version_id: string | null; custody_sha256: string | null; purged_at: Date | null }>;
  certificates: Array<{ id: string; tenant_id: string; envelope_id: string; certificate_sha256: string; custody_object_key: string | null; custody_version_id: string | null; custody_sha256: string | null; purged_at: Date | null }>;
  events: Array<{ envelope_id: string; payload: unknown }>;
  // Retention and Purge W8 — envelope_id → purge_waiting_until (queued, waiting on an Object Lock).
  purge_waiting: Map<string, Date>;
}

@Injectable()
export class SignArtifactCustodyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
  ) {}

  // A purged artifact (Retention and Purge W3) has no bytes left and is never re-uploaded.
  async pendingExecuted(tenant_id: string, envelope_id: string): Promise<PendingExecutedArtifact[]> {
    const rows = await this.prisma.executedDocument.findMany({
      where: { tenant_id, envelope_id, custody_object_key: null, purged_at: null },
      select: { id: true, envelope_document_id: true, executed_sha256: true, byte_size: true, executed_bytes: true },
      orderBy: { produced_at: 'asc' },
    });
    return rows.flatMap((r) => (r.executed_bytes === null ? [] : [{ ...r, executed_bytes: r.executed_bytes }]));
  }

  async pendingCertificate(tenant_id: string, envelope_id: string): Promise<PendingCertificateArtifact | null> {
    const row = await this.prisma.executionCertificate.findFirst({
      where: { tenant_id, envelope_id, custody_object_key: null, purged_at: null },
      select: { id: true, certificate_sha256: true, byte_size: true, certificate_bytes: true },
    });
    return row === null || row.certificate_bytes === null ? null : { ...row, certificate_bytes: row.certificate_bytes };
  }

  /** Hash summary of every executed document of the envelope (evidence snapshot). */
  async executedSummaries(tenant_id: string, envelope_id: string): Promise<ExecutedArtifactSummary[]> {
    return this.prisma.executedDocument.findMany({
      where: { tenant_id, envelope_id },
      select: { id: true, envelope_document_id: true, source_sha256: true, executed_sha256: true, byte_size: true },
      orderBy: { produced_at: 'asc' },
    });
  }

  /** Envelopes with any NULL-custody artifact produced before `cutoff`, oldest first. */
  async pendingEnvelopes(cutoff: Date, max: number): Promise<Array<{ tenant_id: string; envelope_id: string }>> {
    const where = { custody_object_key: null, purged_at: null, produced_at: { lt: cutoff } };
    const select = { tenant_id: true, envelope_id: true } as const;
    const [docs, certs] = await Promise.all([
      this.prisma.executedDocument.findMany({ where, select, orderBy: { produced_at: 'asc' }, take: max }),
      this.prisma.executionCertificate.findMany({ where, select, orderBy: { produced_at: 'asc' }, take: max }),
    ]);
    const out = new Map<string, { tenant_id: string; envelope_id: string }>();
    for (const r of [...docs, ...certs]) {
      if (out.size >= max) break;
      out.set(`${r.tenant_id}/${r.envelope_id}`, { tenant_id: r.tenant_id, envelope_id: r.envelope_id });
    }
    return [...out.values()];
  }

  /**
   * Sets the custody columns only while they are still NULL and, only when this call
   * set them, appends the custody ledger event. Returns whether this call recorded it.
   */
  async recordCustody(input: {
    kind: CustodyArtifactKind;
    artifact_id: string;
    tenant_id: string;
    envelope_id: string;
    columns: CustodyColumns;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx, input.tenant_id, input.envelope_id);
      const where = { id: input.artifact_id, tenant_id: input.tenant_id, envelope_id: input.envelope_id, custody_object_key: null };
      const updated =
        input.kind === 'EXECUTED_DOCUMENT'
          ? await tx.executedDocument.updateMany({ where, data: input.columns })
          : await tx.executionCertificate.updateMany({ where, data: input.columns });
      if (updated.count !== 1) return false;
      await this.repo.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        event_type: EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE,
        actor_type: 'SERVICE',
        payload: input.payload,
      });
      return true;
    });
  }

  /** Recovery validation reads (READ ONLY transaction). */
  async readForValidation(tenant_id: string, envelope_ids: readonly string[]): Promise<CustodyValidationRows> {
    const envelopeFilter = envelope_ids.length > 0 ? { envelope_id: { in: [...envelope_ids] } } : {};
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const custody = { custody_object_key: true, custody_version_id: true, custody_sha256: true, purged_at: true } as const;
      const executed = await tx.executedDocument.findMany({
        where: { tenant_id, ...envelopeFilter },
        select: { id: true, tenant_id: true, envelope_id: true, executed_sha256: true, ...custody },
      });
      const certificates = await tx.executionCertificate.findMany({
        where: { tenant_id, ...envelopeFilter },
        select: { id: true, tenant_id: true, envelope_id: true, certificate_sha256: true, ...custody },
      });
      const events = await tx.signatureEvent.findMany({
        where: { tenant_id, event_type: EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE, ...envelopeFilter },
        select: { envelope_id: true, payload: true },
        orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
      });
      const waiting = await tx.signatureEnvelope.findMany({
        where: { tenant_id, purge_state: 'QUEUED', purge_waiting_until: { not: null }, ...(envelope_ids.length > 0 ? { id: { in: [...envelope_ids] } } : {}) },
        select: { id: true, purge_waiting_until: true },
      });
      const purge_waiting = new Map(waiting.flatMap((w) => (w.purge_waiting_until !== null ? [[w.id, w.purge_waiting_until] as const] : [])));
      return { executed, certificates, events, purge_waiting };
    });
  }
}
