import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { EsignRepository } from '../esign.repository.js';
import {
  DOCUMENT_SEAL_SIGNING_PROVIDER,
  DOCUMENT_SEAL_TIMESTAMP_SOURCE,
  type DocumentSealSigningProvider,
  type DocumentSealTimestampSource,
} from '../ports/document-seal.port.js';

import { sealPdf, type PadesLevel } from './pades.js';

// Feature-Parity Directive v1.0 §1.15 (AATL document seal), Amendment A1 — seals each
// NEWLY executed document with a PAdES signature, after the executed document is kept
// and before the execution certificate and custody are written.
//   - The ExecutedDocument row (write-once, SX-1) and its executed_sha256 are never
//     changed. The seal is an incremental update stored as seal_tail; the sealed PDF is
//     executed_bytes || seal_tail.
//   - A sealed document is recorded in the append-only, hash-chained ledger as
//     EXECUTED_DOCUMENT_SEALED (executed SHA-256 -> sealed SHA-256), so the evidence
//     chain references the sealed artifact.
//   - A failure never blocks completion: the row stays PENDING with a backoff and the
//     seal job retries it; after MAX_SEAL_ATTEMPTS it is FAILED (the unsealed executed
//     document remains the record).
//   - Dark: with no signing provider bound, nothing is written. Envelopes completed
//     before the seal was enabled are never sealed retroactively.

export const EXECUTED_DOCUMENT_SEALED = 'EXECUTED_DOCUMENT_SEALED';
export const MAX_SEAL_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;

export type DocumentSealStatus = 'PENDING' | 'SEALED' | 'FAILED';

export interface DocumentSealSummary {
  envelope_document_id: string;
  status: DocumentSealStatus;
  seal_level: PadesLevel | null;
  sealed_sha256: string | null;
  signer_subject: string | null;
}

/** The ledger payload of EXECUTED_DOCUMENT_SEALED (hashed into the event chain). */
export interface ExecutedDocumentSealedPayload {
  artifact_kind: 'EXECUTED_DOCUMENT_SEAL';
  artifact_id: string;
  executed_document_id: string;
  envelope_document_id: string;
  executed_sha256: string;
  executed_byte_size: number;
  sha256: string; // the sealed PDF
  byte_size: number;
  seal_tail_sha256: string;
  seal_level: PadesLevel;
  provider: string;
  signer_certificate_sha256: string;
  signing_time: string;
}

/** The sealed PDF from its stored parts. */
export function sealedPdfBytes(executed_bytes: Uint8Array, seal_tail: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(executed_bytes), Buffer.from(seal_tail)]);
}

export function sealBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class DocumentSealService {
  private readonly logger = new Logger('DocumentSealService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Optional() @Inject(DOCUMENT_SEAL_SIGNING_PROVIDER) private readonly provider?: DocumentSealSigningProvider | null,
    @Optional() @Inject(DOCUMENT_SEAL_TIMESTAMP_SOURCE) private readonly timestamp?: DocumentSealTimestampSource | null,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return this.provider !== undefined && this.provider !== null;
  }

  /**
   * Seal the executed documents just produced for an envelope (one attempt each).
   * Never throws; returns one summary per document (empty when the seal is off).
   */
  async sealProduced(tenant_id: string, envelope_id: string, envelope_document_ids: readonly string[]): Promise<DocumentSealSummary[]> {
    if (!this.enabled || envelope_document_ids.length === 0) return [];
    const out: DocumentSealSummary[] = [];
    try {
      const executed = await this.prisma.executedDocument.findMany({
        where: { tenant_id, envelope_id, envelope_document_id: { in: [...envelope_document_ids] } },
        select: { id: true, envelope_document_id: true, executed_sha256: true },
      });
      for (const d of executed) {
        const seal_id = await this.ensurePending(tenant_id, envelope_id, d);
        out.push(await this.attempt(seal_id));
      }
    } catch (e) {
      this.logger.warn(`document_seal.produce_failed envelope=${envelope_id} error=${(e as Error).name}`);
    }
    return out;
  }

  /** The seal job: one attempt for each due PENDING row. */
  async retryDue(limit = 25): Promise<{ attempted: number; sealed: number }> {
    if (!this.enabled) return { attempted: 0, sealed: 0 };
    const due = await this.prisma.executedDocumentSeal.findMany({
      where: { status: 'PENDING', OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: this.now() } }] },
      orderBy: [{ next_attempt_at: 'asc' }],
      take: limit,
      select: { id: true },
    });
    let sealed = 0;
    for (const row of due) if ((await this.attempt(row.id)).status === 'SEALED') sealed += 1;
    return { attempted: due.length, sealed };
  }

  private async ensurePending(
    tenant_id: string,
    envelope_id: string,
    d: { id: string; envelope_document_id: string; executed_sha256: string },
  ): Promise<string> {
    const existing = await this.prisma.executedDocumentSeal.findUnique({ where: { executed_document_id: d.id }, select: { id: true } });
    if (existing !== null) return existing.id;
    try {
      const id = randomUUID();
      await this.prisma.executedDocumentSeal.create({
        data: { id, tenant_id, envelope_id, executed_document_id: d.id, envelope_document_id: d.envelope_document_id, executed_sha256: d.executed_sha256, status: 'PENDING' },
      });
      return id;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const raced = await this.prisma.executedDocumentSeal.findUnique({ where: { executed_document_id: d.id }, select: { id: true } });
      if (raced === null) throw e;
      return raced.id;
    }
  }

  /** One seal attempt. Never throws. */
  async attempt(seal_id: string): Promise<DocumentSealSummary> {
    const row = await this.prisma.executedDocumentSeal.findUnique({ where: { id: seal_id } });
    if (row === null) throw new Error(`document seal ${seal_id} not found`);
    const summary = (status: DocumentSealStatus, s: { seal_level?: string | null; sealed_sha256?: string | null; signer_subject?: string | null } = row): DocumentSealSummary => ({
      envelope_document_id: row.envelope_document_id,
      status,
      seal_level: (s.seal_level ?? null) as PadesLevel | null,
      sealed_sha256: s.sealed_sha256 ?? null,
      signer_subject: s.signer_subject ?? null,
    });
    if (row.status !== 'PENDING' || this.provider === undefined || this.provider === null) return summary(row.status as DocumentSealStatus);

    const executed = await this.prisma.executedDocument.findUnique({
      where: { id: row.executed_document_id },
      select: { executed_bytes: true, executed_sha256: true, byte_size: true },
    });
    try {
      if (executed === null || executed.executed_bytes === null) throw Object.assign(new Error('executed document has no bytes'), { name: 'ExecutedDocumentPurged', terminal: true });
      // Seal exactly the kept artifact: its bytes must still hash to the recorded value.
      if (sha256Hex(executed.executed_bytes) !== row.executed_sha256 || executed.executed_sha256 !== row.executed_sha256) {
        throw Object.assign(new Error('executed bytes do not match the recorded SHA-256'), { name: 'ExecutedDigestMismatch', terminal: true });
      }
      const signing_time = this.now();
      const result = await sealPdf(executed.executed_bytes, { provider: this.provider, timestamp: this.timestamp ?? null, signing_time });
      const sealed_sha256 = sha256Hex(result.sealed_bytes);
      const sealed_at = this.now();
      const written = await this.prisma.$transaction(async (tx) => {
        await this.repo.lockEnvelope(tx, row.tenant_id, row.envelope_id);
        const updated = await tx.executedDocumentSeal.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: {
            status: 'SEALED',
            attempts: { increment: 1 },
            next_attempt_at: null,
            last_error: null,
            provider: this.provider?.provider_id ?? 'unknown',
            seal_level: result.level,
            sealed_sha256,
            sealed_byte_size: result.sealed_bytes.length,
            signer_certificate_sha256: result.signer_certificate_sha256,
            signer_subject: result.signer_subject,
            signing_time,
            seal_tail: Buffer.from(result.seal_tail),
            sealed_at,
          },
        });
        if (updated.count !== 1) return false;
        const payload: ExecutedDocumentSealedPayload = {
          artifact_kind: 'EXECUTED_DOCUMENT_SEAL',
          artifact_id: row.id,
          executed_document_id: row.executed_document_id,
          envelope_document_id: row.envelope_document_id,
          executed_sha256: row.executed_sha256,
          executed_byte_size: executed.byte_size,
          sha256: sealed_sha256,
          byte_size: result.sealed_bytes.length,
          seal_tail_sha256: sha256Hex(result.seal_tail),
          seal_level: result.level,
          provider: this.provider?.provider_id ?? 'unknown',
          signer_certificate_sha256: result.signer_certificate_sha256,
          signing_time: signing_time.toISOString(),
        };
        await this.repo.appendEvent(tx, { tenant_id: row.tenant_id, envelope_id: row.envelope_id, event_type: EXECUTED_DOCUMENT_SEALED, actor_type: 'SYSTEM', payload });
        return true;
      });
      if (!written) {
        const now = await this.prisma.executedDocumentSeal.findUnique({ where: { id: row.id } });
        return summary((now?.status ?? 'PENDING') as DocumentSealStatus, now ?? row);
      }
      return summary('SEALED', { seal_level: result.level, sealed_sha256, signer_subject: result.signer_subject });
    } catch (e) {
      const err = e as Error & { terminal?: boolean };
      const attempts = row.attempts + 1;
      const failed = err.terminal === true || attempts >= MAX_SEAL_ATTEMPTS;
      // Only the error class is stored and logged: never a message that could carry content.
      await this.prisma.executedDocumentSeal.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          attempts,
          last_error: err.name.slice(0, 100),
          status: failed ? 'FAILED' : 'PENDING',
          next_attempt_at: failed ? null : new Date(this.now().getTime() + sealBackoffMs(attempts)),
        },
      }).catch(() => undefined);
      this.logger.warn(`document_seal.attempt_failed seal=${row.id} attempts=${attempts} error=${err.name}${failed ? ' final' : ''}`);
      return summary(failed ? 'FAILED' : 'PENDING');
    }
  }
}
