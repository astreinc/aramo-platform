import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import { buildScreeningFindingPayload, screeningPayloadHash } from './screening-payload.js';
import type { ScreeningEventType } from './screening-vocab.js';

// TIP-E2E INC-3 — the technical_screening persistence surface
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §4–§7, §10.3).
//
// Every read is tenant-bound (another tenant's id ≡ an absent one). Every DRAFT
// mutation carries the session version IN THE WRITE PREDICATE (a guarded
// updateMany + affected-row check — never a read-then-write CAS), and its
// content-free ScreeningEvent is appended in the SAME transaction. Confirmation
// writes the CONFIRMED transition, one pinned PENDING publication intent per
// finding and SESSION_CONFIRMED atomically. Publication attempts serialize on the
// intent row (SELECT … FOR UPDATE) and rebuild the trust call ONLY from the
// pinned intent. No delete path exists here except DRAFT finding removal
// (directive §10.1 — confinement-spec enforced).

export interface ScreeningSessionRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  talent_record_id: string;
  interaction_id: string | null;
  state: string;
  version: number;
  created_by_actor_id: string;
  created_at: Date;
  updated_at: Date;
  confirmed_by_actor_id: string | null;
  confirmed_at: Date | null;
  confirmed_version: number | null;
  confirmation_attested: boolean | null;
  voided_by_actor_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
}

export interface ScreeningFindingRow {
  id: string;
  tenant_id: string;
  session_id: string;
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScreeningPublicationRow {
  id: string;
  tenant_id: string;
  session_id: string;
  finding_id: string;
  evidence_record_id: string;
  talent_record_id_at_confirm: string;
  canonical_payload: unknown;
  payload_hash: string;
  collected_at: Date;
  state: string;
  attempt_count: number;
  last_attempt_at: Date | null;
  last_error_code: string | null;
  published_at: Date | null;
  created_at: Date;
}

export interface ScreeningEventRow {
  id: string;
  tenant_id: string;
  session_id: string;
  event_type: string;
  actor_id: string;
  session_version: number;
  payload: unknown;
  occurred_at: Date;
}

export interface ScreeningFindingFields {
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
}

// Why a DRAFT-guarded write matched no row. Classified AFTER the guarded write
// fails, so the refusal order is: absent (404) → not DRAFT (422) → stale (409).
export type DraftGuardFailure = 'not_found' | 'state_invalid' | 'version_conflict';

export class ScreeningGuardError extends Error {
  constructor(readonly reason: DraftGuardFailure | 'finding_not_found' | 'finding_set_mismatch') {
    super(reason);
    this.name = 'ScreeningGuardError';
  }
}

type ScreeningTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

// The interactive-transaction window for one publication attempt: it spans the
// synchronous Talent Trust write (its own transaction on its own connection).
const PUBLICATION_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

@Injectable()
export class TechnicalScreeningRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- reads (tenant-bound) -------------------------------------------

  async findSession(tenantId: string, sessionId: string): Promise<ScreeningSessionRow | null> {
    return (await this.prisma.screeningSession.findFirst({
      where: { id: sessionId, tenant_id: tenantId },
    })) as ScreeningSessionRow | null;
  }

  async listSessionsForTalent(tenantId: string, talentRecordId: string): Promise<ScreeningSessionRow[]> {
    return (await this.prisma.screeningSession.findMany({
      where: { tenant_id: tenantId, talent_record_id: talentRecordId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    })) as ScreeningSessionRow[];
  }

  async listFindings(tenantId: string, sessionId: string): Promise<ScreeningFindingRow[]> {
    return (await this.prisma.screeningFinding.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningFindingRow[];
  }

  async listPublications(tenantId: string, sessionId: string): Promise<ScreeningPublicationRow[]> {
    return (await this.prisma.screeningEvidencePublication.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningPublicationRow[];
  }

  async listEvents(tenantId: string, sessionId: string): Promise<ScreeningEventRow[]> {
    return (await this.prisma.screeningEvent.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningEventRow[];
  }

  // ---- DRAFT lifecycle -------------------------------------------------

  async createSession(input: {
    tenant_id: string;
    site_id: string | null;
    talent_record_id: string;
    interaction_id: string | null;
    actor_id: string;
  }): Promise<ScreeningSessionRow> {
    return this.prisma.$transaction(async (tx) => {
      const session = (await tx.screeningSession.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          site_id: input.site_id,
          talent_record_id: input.talent_record_id,
          interaction_id: input.interaction_id,
          state: 'DRAFT',
          version: 1,
          created_by_actor_id: input.actor_id,
        },
      })) as ScreeningSessionRow;
      await this.appendEvent(tx, session, 'SESSION_CREATED', input.actor_id, session.version, {});
      return session;
    });
  }

  async addFinding(input: {
    tenant_id: string;
    session_id: string;
    expected_version: number;
    actor_id: string;
    fields: ScreeningFindingFields;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const finding = (await tx.screeningFinding.create({
        data: { id: uuidv7(), tenant_id: input.tenant_id, session_id: input.session_id, ...input.fields },
      })) as ScreeningFindingRow;
      await this.appendEvent(tx, session, 'FINDING_ADDED', input.actor_id, session.version, {
        finding_id: finding.id,
        basis: finding.basis,
      });
      return { finding, version: session.version };
    });
  }

  async editFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    expected_version: number;
    actor_id: string;
    fields: ScreeningFindingFields;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const updated = await tx.screeningFinding.updateMany({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
        data: { ...input.fields, updated_at: new Date() },
      });
      if (updated.count !== 1) throw new ScreeningGuardError('finding_not_found');
      const finding = (await tx.screeningFinding.findFirstOrThrow({
        where: { id: input.finding_id, tenant_id: input.tenant_id },
      })) as ScreeningFindingRow;
      await this.appendEvent(tx, session, 'FINDING_EDITED', input.actor_id, session.version, {
        finding_id: finding.id,
        basis: finding.basis,
      });
      return { finding, version: session.version };
    });
  }

  // The one application delete path on screening tables (directive §10.1): a
  // finding of a DRAFT session, inside the same version-guarded transaction.
  async removeFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    expected_version: number;
    actor_id: string;
  }): Promise<{ version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const removed = await tx.screeningFinding.deleteMany({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
      });
      if (removed.count !== 1) throw new ScreeningGuardError('finding_not_found');
      await this.appendEvent(tx, session, 'FINDING_REMOVED', input.actor_id, session.version, {
        finding_id: input.finding_id,
      });
      return { version: session.version };
    });
  }

  async voidSession(input: {
    tenant_id: string;
    session_id: string;
    expected_version: number;
    actor_id: string;
    reason: string | null;
    now: Date;
  }): Promise<ScreeningSessionRow> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.screeningSession.updateMany({
        where: {
          id: input.session_id,
          tenant_id: input.tenant_id,
          state: 'DRAFT',
          version: input.expected_version,
        },
        data: {
          state: 'VOIDED',
          version: input.expected_version + 1,
          voided_by_actor_id: input.actor_id,
          voided_at: input.now,
          void_reason: input.reason,
          updated_at: input.now,
        },
      });
      if (res.count !== 1) await this.throwGuardFailure(tx, input.tenant_id, input.session_id);
      const session = await this.loadSession(tx, input.tenant_id, input.session_id);
      await this.appendEvent(tx, session, 'SESSION_VOIDED', input.actor_id, session.version, {
        has_reason: input.reason !== null,
      });
      return session;
    });
  }

  // Directive §6 — ONE screening transaction: CAS to CONFIRMED (actor, server
  // time, version, attestation), one PENDING intent per finding with every
  // publication input pinned, SESSION_CONFIRMED. Any failure → nothing commits.
  async confirmSession(input: {
    tenant_id: string;
    session_id: string;
    expected_version: number;
    confirmed_finding_ids: readonly string[];
    actor_id: string;
    now: Date;
  }): Promise<{ session: ScreeningSessionRow; publications: ScreeningPublicationRow[] }> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.screeningSession.updateMany({
        where: {
          id: input.session_id,
          tenant_id: input.tenant_id,
          state: 'DRAFT',
          version: input.expected_version,
        },
        data: {
          state: 'CONFIRMED',
          version: input.expected_version + 1,
          confirmed_by_actor_id: input.actor_id,
          confirmed_at: input.now,
          confirmed_version: input.expected_version,
          confirmation_attested: true,
          updated_at: input.now,
        },
      });
      if (res.count !== 1) await this.throwGuardFailure(tx, input.tenant_id, input.session_id);
      const session = await this.loadSession(tx, input.tenant_id, input.session_id);
      const findings = (await tx.screeningFinding.findMany({
        where: { tenant_id: input.tenant_id, session_id: input.session_id },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      })) as ScreeningFindingRow[];
      const stored = [...findings.map((f) => f.id)].sort();
      const requested = [...new Set(input.confirmed_finding_ids)].sort();
      if (
        stored.length === 0 ||
        stored.length !== requested.length ||
        stored.some((id, i) => id !== requested[i])
      ) {
        throw new ScreeningGuardError('finding_set_mismatch');
      }
      const intents = findings.map((finding) => {
        const payload = buildScreeningFindingPayload({
          session_id: session.id,
          finding,
          confirmed_at: input.now,
          confirmed_version: input.expected_version,
        });
        return {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          session_id: session.id,
          finding_id: finding.id,
          evidence_record_id: uuidv7(),
          talent_record_id_at_confirm: session.talent_record_id,
          canonical_payload: payload as object,
          payload_hash: screeningPayloadHash(payload),
          collected_at: input.now,
          state: 'PENDING',
        };
      });
      await tx.screeningEvidencePublication.createMany({ data: intents });
      await this.appendEvent(tx, session, 'SESSION_CONFIRMED', input.actor_id, session.version, {
        finding_count: findings.length,
        confirmed_version: input.expected_version,
      });
      const publications = (await tx.screeningEvidencePublication.findMany({
        where: { tenant_id: input.tenant_id, session_id: session.id },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      })) as ScreeningPublicationRow[];
      return { session, publications };
    });
  }

  // ---- publication (directive §7) -------------------------------------

  async listPendingPublicationIds(tenantId: string, sessionId: string): Promise<string[]> {
    const rows = await this.prisma.screeningEvidencePublication.findMany({
      where: { tenant_id: tenantId, session_id: sessionId, state: 'PENDING' },
      select: { id: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => r.id);
  }

  // One attempt for one intent. The intent row is locked FOR UPDATE for the whole
  // attempt, so concurrent attempts serialize; a non-PENDING intent is skipped.
  // `attempt` performs the trust write from the PINNED intent and classifies the
  // outcome; its result is recorded in this same screening transaction.
  async runPublicationAttempt(input: {
    tenant_id: string;
    publication_id: string;
    actor_id: string;
    now: () => Date;
    attempt: (
      intent: ScreeningPublicationRow,
    ) => Promise<{ outcome: 'published'; written: boolean } | { outcome: 'conflict' } | { outcome: 'failed'; error_code: string }>;
  }): Promise<{ publication_id: string; state: string; skipped: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "technical_screening"."ScreeningEvidencePublication"
         WHERE id = ${input.publication_id}::uuid AND tenant_id = ${input.tenant_id}::uuid
         FOR UPDATE`;
      if (locked.length === 0) throw new ScreeningGuardError('not_found');
      const intent = (await tx.screeningEvidencePublication.findFirstOrThrow({
        where: { id: input.publication_id, tenant_id: input.tenant_id },
      })) as ScreeningPublicationRow;
      if (intent.state !== 'PENDING') {
        return { publication_id: intent.id, state: intent.state, skipped: true };
      }
      const session = await this.loadSession(tx, input.tenant_id, intent.session_id);
      const result = await input.attempt(intent);
      const at = input.now();
      const base = { publication_id: intent.id, finding_id: intent.finding_id };
      if (result.outcome === 'published') {
        await tx.screeningEvidencePublication.update({
          where: { id: intent.id },
          data: {
            state: 'PUBLISHED',
            published_at: at,
            attempt_count: { increment: 1 },
            last_attempt_at: at,
            last_error_code: null,
          },
        });
        await this.appendEvent(tx, session, 'FINDING_PUBLISHED', input.actor_id, session.version, {
          ...base,
          written: result.written,
        });
        return { publication_id: intent.id, state: 'PUBLISHED', skipped: false };
      }
      if (result.outcome === 'conflict') {
        await tx.screeningEvidencePublication.update({
          where: { id: intent.id },
          data: {
            state: 'CONFLICT',
            attempt_count: { increment: 1 },
            last_attempt_at: at,
            last_error_code: 'IDEMPOTENCY_KEY_CONFLICT',
          },
        });
        await this.appendEvent(tx, session, 'PUBLICATION_CONFLICT', input.actor_id, session.version, base);
        return { publication_id: intent.id, state: 'CONFLICT', skipped: false };
      }
      await tx.screeningEvidencePublication.update({
        where: { id: intent.id },
        data: {
          attempt_count: { increment: 1 },
          last_attempt_at: at,
          last_error_code: result.error_code,
        },
      });
      await this.appendEvent(tx, session, 'PUBLICATION_ATTEMPT_FAILED', input.actor_id, session.version, {
        ...base,
        error_code: result.error_code,
      });
      return { publication_id: intent.id, state: 'PENDING', skipped: false };
    }, PUBLICATION_TX_OPTIONS);
  }

  // ---- talent merge re-key (directive §10.3) ---------------------------

  // TR-2a-B3b operational repoint contract: move this tenant's sessions from the
  // husk record to the survivor. Publication intents are NOT re-keyed (they keep
  // talent_record_id_at_confirm). The terminal-session trigger permits exactly
  // this column. No unique key on the column → no collision → removed_rows [].
  async repointTalentRecordRefs(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
    only_ids?: string[];
  }): Promise<{ repointed_ids: string[]; removed_rows: unknown[] }> {
    const params: unknown[] = [args.to_record_id, args.from_record_id, args.tenant_id];
    let idFilter = '';
    if (args.only_ids && args.only_ids.length > 0) {
      params.push(args.only_ids);
      idFilter = `AND id = ANY($${params.length}::uuid[])`;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "technical_screening"."ScreeningSession"
          SET talent_record_id = $1::uuid, updated_at = now()
        WHERE talent_record_id = $2::uuid AND tenant_id = $3::uuid ${idFilter}
        RETURNING id`,
      ...params,
    );
    return { repointed_ids: rows.map((r) => r.id), removed_rows: [] };
  }

  // ---- internals ------------------------------------------------------

  private async bumpDraft(
    tx: ScreeningTx,
    tenantId: string,
    sessionId: string,
    expectedVersion: number,
  ): Promise<ScreeningSessionRow> {
    const res = await tx.screeningSession.updateMany({
      where: { id: sessionId, tenant_id: tenantId, state: 'DRAFT', version: expectedVersion },
      data: { version: expectedVersion + 1, updated_at: new Date() },
    });
    if (res.count !== 1) await this.throwGuardFailure(tx, tenantId, sessionId);
    return this.loadSession(tx, tenantId, sessionId);
  }

  private async throwGuardFailure(tx: ScreeningTx, tenantId: string, sessionId: string): Promise<never> {
    const current = await tx.screeningSession.findFirst({
      where: { id: sessionId, tenant_id: tenantId },
      select: { state: true },
    });
    if (current === null) throw new ScreeningGuardError('not_found');
    if (current.state !== 'DRAFT') throw new ScreeningGuardError('state_invalid');
    throw new ScreeningGuardError('version_conflict');
  }

  private async loadSession(tx: ScreeningTx, tenantId: string, sessionId: string): Promise<ScreeningSessionRow> {
    const row = await tx.screeningSession.findFirst({ where: { id: sessionId, tenant_id: tenantId } });
    if (row === null) throw new ScreeningGuardError('not_found');
    return row as ScreeningSessionRow;
  }

  private async appendEvent(
    tx: ScreeningTx,
    session: { id: string; tenant_id: string },
    eventType: ScreeningEventType,
    actorId: string,
    sessionVersion: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.screeningEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: session.tenant_id,
        session_id: session.id,
        event_type: eventType,
        actor_id: actorId,
        session_version: sessionVersion,
        payload: payload as object,
      },
    });
  }
}
