import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-3 / §4 D-2 —
// the Sign-owned half of an ATS talent erasure. The ATS erasure engine never reads or
// writes the sign schema; it asks Sign, through this contract, what Sign holds about
// the talent and asks Sign to erase what Sign may erase.
//
// SIGNING EVIDENCE IS NEVER TOUCHED. Nothing here changes or deletes an envelope,
// envelope document, signer, field value, signing session, ledger event
// (SignatureEvent), executed document or execution certificate. The rows erase()
// deletes are exactly the request-replay caches and the already-delivered outbox
// events whose JSON names an erased talent record:
//   sign."IdempotencyKey"      (provider-seam replay cache)
//   sign."SignIdempotencyKey"  (Sign API replay cache)
//   sign."OutboxEvent"         (published rows only)
//
// HOLDS: identity."Tenant".legal_hold (TM-L12), the same hold the retention sweeps honour.
// Every statement is tenant-scoped.

export type SignErasureHolderClassification = 'LEGAL_HOLD' | 'PENDING_PO_LEGAL' | 'PENDING_OUTBOX_DRAIN';

export interface SignErasureHolder {
  holder: string;
  classification: SignErasureHolderClassification;
  count: number;
  reason: string;
}

export interface SignTalentErasureScope {
  tenant_id: string;
  record_ids: string[];
  document_refs: string[];
}

export interface SignTalentErasureCounts {
  idempotency_keys: number;
  api_idempotency_keys: number;
  outbox_events: number;
}

export interface SignTalentErasurePreflight {
  holders: SignErasureHolder[];
  /** What erase() would delete now (the subject-access inventory reads this). */
  erasable: SignTalentErasureCounts;
}

export type SignTalentErasureOutcome =
  | { status: 'erased'; counts: SignTalentErasureCounts }
  | { status: 'blocked'; holders: SignErasureHolder[] };

// A JSON payload (read as text) that names any of the record ids ($2).
const NAMES_A_RECORD = (col: string): string =>
  `${col}::text LIKE ANY (ARRAY(SELECT '%' || r::text || '%' FROM unnest($2::uuid[]) r))`;

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Exec = Pick<Tx, '$queryRawUnsafe'>;

@Injectable()
export class SignTalentErasureRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Read-only: every Sign holder that blocks erasing this talent, and what erase() would delete. */
  async preflight(scope: SignTalentErasureScope): Promise<SignTalentErasurePreflight> {
    const holders = await this.holders(this.prisma, scope);
    const n = async (table: string, col: string, extra = ''): Promise<number> => {
      if (scope.record_ids.length === 0) return 0;
      const rows = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1::uuid ${extra} AND ${NAMES_A_RECORD(col)}`,
        scope.tenant_id,
        scope.record_ids,
      );
      return Number(rows[0]?.n ?? 0);
    };
    return {
      holders,
      erasable: {
        idempotency_keys: await n('sign."IdempotencyKey"', 'response_body'),
        api_idempotency_keys: await n('sign."SignIdempotencyKey"', 'response_body'),
        outbox_events: await n('sign."OutboxEvent"', 'event_payload', 'AND published_at IS NOT NULL'),
      },
    };
  }

  /**
   * Erases Sign's replay caches and delivered outbox events naming the records, in one
   * transaction, after re-checking every holder under the tenant's erasure lock. A second
   * call finds nothing left and deletes nothing (idempotent).
   */
  async erase(scope: SignTalentErasureScope): Promise<SignTalentErasureOutcome> {
    if (scope.record_ids.length === 0) return { status: 'erased', counts: { idempotency_keys: 0, api_idempotency_keys: 0, outbox_events: 0 } };
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('sign.talent-erasure:' || $1::text, 0))`, scope.tenant_id);
      const holders = await this.holders(tx, scope);
      if (holders.length > 0) return { status: 'blocked', holders };
      const del = async (table: string, col: string, extra = ''): Promise<number> => {
        const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
          `WITH d AS (DELETE FROM ${table} WHERE tenant_id = $1::uuid ${extra} AND ${NAMES_A_RECORD(col)} RETURNING 1)
           SELECT count(*)::int AS n FROM d`,
          scope.tenant_id,
          scope.record_ids,
        );
        return Number(rows[0]?.n ?? 0);
      };
      return {
        status: 'erased',
        counts: {
          idempotency_keys: await del('sign."IdempotencyKey"', 'response_body'),
          api_idempotency_keys: await del('sign."SignIdempotencyKey"', 'response_body'),
          outbox_events: await del('sign."OutboxEvent"', 'event_payload', 'AND published_at IS NOT NULL'),
        },
      };
    });
  }

  private async holders(db: Exec, scope: SignTalentErasureScope): Promise<SignErasureHolder[]> {
    const count = async (sql: string, ...params: unknown[]): Promise<number> => {
      const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(sql, ...params);
      return Number(rows[0]?.n ?? 0);
    };
    const out: SignErasureHolder[] = [];
    const held = await count(`SELECT count(*)::int AS n FROM identity."Tenant" WHERE id = $1::uuid AND legal_hold = true`, scope.tenant_id);
    if (held > 0) out.push({ holder: 'identity."Tenant".legal_hold', classification: 'LEGAL_HOLD', count: held, reason: 'the tenant is under legal hold' });
    if (scope.document_refs.length > 0) {
      const envelopes = await count(
        `SELECT count(*)::int AS n FROM sign."EnvelopeDocument" WHERE tenant_id = $1::uuid AND document_ref = ANY($2::uuid[])`,
        scope.tenant_id,
        scope.document_refs,
      );
      if (envelopes > 0) {
        out.push({
          holder: 'sign."EnvelopeDocument"',
          classification: 'PENDING_PO_LEGAL',
          count: envelopes,
          reason: 'e-signature envelope over a talent document (executed-record retention; signer PII)',
        });
      }
    }
    if (scope.record_ids.length > 0) {
      const unpublished = await count(
        `SELECT count(*)::int AS n FROM sign."OutboxEvent" WHERE tenant_id = $1::uuid AND published_at IS NULL AND ${NAMES_A_RECORD('event_payload')}`,
        scope.tenant_id,
        scope.record_ids,
      );
      if (unpublished > 0) {
        out.push({
          holder: 'sign."OutboxEvent" (unpublished)',
          classification: 'PENDING_OUTBOX_DRAIN',
          count: unpublished,
          reason: 'an unpublished Sign outbox event names the talent — retry once it has been delivered',
        });
      }
    }
    return out;
  }
}
