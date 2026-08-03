import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  ClientTalentRestrictionView,
  CloseRestrictionInput,
  CreateRestrictionInput,
} from './dto/client-talent-restriction.view.js';
import type {
  AssertedByTypeValue,
  CloseReasonCodeValue,
  RestrictionTypeValue,
  SourceSystemValue,
} from './client-talent-restriction-vocab.js';

// Row shape as returned by Prisma (subset used by the projection). Cast at
// the read boundary — the generated client types are structurally
// compatible; this keeps the repository decoupled from the generated path.
interface ClientTalentRestrictionRow {
  id: string;
  tenant_id: string;
  client_company_id: string;
  talent_record_id: string;
  restriction_type: RestrictionTypeValue;
  asserted_by_type: AssertedByTypeValue;
  asserting_organization_reference: string | null;
  asserting_contact_reference: string | null;
  source_system: SourceSystemValue;
  source_reference: string;
  raw_source_value: string | null;
  reason_code: string;
  recorded_by: string;
  effective_from: Date;
  scheduled_end_at: Date | null;
  recorded_at: Date;
  effective_to: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason_code: CloseReasonCodeValue | null;
  close_source_system: SourceSystemValue | null;
  close_source_reference: string | null;
}

// active = effective_from <= now
//   AND (scheduled_end_at IS NULL OR scheduled_end_at > now)
//   AND (effective_to   IS NULL OR effective_to   > now)
// The earliest applicable end controls validity (E7 Option B). Derived,
// never stored.
function isActiveAt(row: ClientTalentRestrictionRow, now: Date): boolean {
  if (row.effective_from.getTime() > now.getTime()) return false;
  if (row.scheduled_end_at !== null && row.scheduled_end_at.getTime() <= now.getTime()) return false;
  if (row.effective_to !== null && row.effective_to.getTime() <= now.getTime()) return false;
  return true;
}

function projectView(
  row: ClientTalentRestrictionRow,
  now: Date,
): ClientTalentRestrictionView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    client_company_id: row.client_company_id,
    talent_record_id: row.talent_record_id,
    restriction_type: row.restriction_type,
    asserted_by_type: row.asserted_by_type,
    asserting_organization_reference: row.asserting_organization_reference,
    asserting_contact_reference: row.asserting_contact_reference,
    source_system: row.source_system,
    source_reference: row.source_reference,
    raw_source_value: row.raw_source_value,
    reason_code: row.reason_code,
    recorded_by: row.recorded_by,
    effective_from: row.effective_from,
    scheduled_end_at: row.scheduled_end_at,
    recorded_at: row.recorded_at,
    effective_to: row.effective_to,
    closed_at: row.closed_at,
    closed_by: row.closed_by,
    close_reason_code: row.close_reason_code,
    close_source_system: row.close_source_system,
    close_source_reference: row.close_source_reference,
    active: isActiveAt(row, now),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

// ClientTalentRestrictionRepository — the record half of the house pattern
// (E7 §5). Create-and-close only: NO update-in-place, NO delete, and
// deliberately NO cross-client or per-talent aggregation surface (E7
// R2/R3). Every read is client-and-talent-scoped below the controller
// layer too — there is no findAllByTalent / countByTalent /
// findRestrictedTalent, by design.
@Injectable()
export class ClientTalentRestrictionRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('ClientTalentRestrictionRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  // Idempotent record. The assertion identity (tenant_id, source_system,
  // source_reference, restriction_type) is the idempotency key (§3b
  // correction 4). Handled DELIBERATELY — the unique index is the floor,
  // not the only mechanism:
  //   1. look up by the assertion identity
  //   2. return the existing record when found (same-source retry)
  //   3. attempt creation when absent
  //   4. on a concurrent unique-conflict race, reread and return canonical
  // A valid retry NEVER surfaces a generic database-conflict error.
  async recordRestriction(
    input: CreateRestrictionInput,
    requestId: string,
  ): Promise<ClientTalentRestrictionView> {
    const now = new Date();

    const existing = await this.findByAssertionIdentity(input);
    if (existing !== null) {
      this.logger.log({
        event: 'client_talent_restriction_create_idempotent_replay',
        request_id: requestId,
        tenant_id: input.tenant_id,
        client_company_id: input.client_company_id,
        talent_record_id: input.talent_record_id,
        restriction_id: existing.id,
      });
      return projectView(existing, now);
    }

    const data: Record<string, unknown> = {
      tenant_id: input.tenant_id,
      client_company_id: input.client_company_id,
      talent_record_id: input.talent_record_id,
      restriction_type: input.restriction_type,
      asserted_by_type: input.asserted_by_type,
      asserting_organization_reference: input.asserting_organization_reference ?? null,
      asserting_contact_reference: input.asserting_contact_reference ?? null,
      source_system: input.source_system,
      source_reference: input.source_reference,
      raw_source_value: input.raw_source_value ?? null,
      reason_code: input.reason_code,
      recorded_by: input.recorded_by,
      effective_from: input.effective_from,
      scheduled_end_at: input.scheduled_end_at ?? null,
    };

    try {
      const created = await this.prisma.clientTalentRestriction.create({
        data: data as never,
      });
      this.logger.log({
        event: 'client_talent_restriction_created',
        request_id: requestId,
        tenant_id: input.tenant_id,
        client_company_id: input.client_company_id,
        talent_record_id: input.talent_record_id,
        restriction_id: (created as ClientTalentRestrictionRow).id,
        restriction_type: input.restriction_type,
        source_system: input.source_system,
      });
      return projectView(created as ClientTalentRestrictionRow, now);
    } catch (err) {
      // Concurrent-insert race on the assertion identity: reread and return
      // the canonical row. A valid retry is idempotent, not a 409.
      if (isUniqueViolation(err)) {
        const canonical = await this.findByAssertionIdentity(input);
        if (canonical !== null) {
          this.logger.log({
            event: 'client_talent_restriction_create_race_resolved',
            tenant_id: input.tenant_id,
            restriction_id: canonical.id,
          });
          return projectView(canonical, now);
        }
      }
      throw err;
    }
  }

  // The explicit close — the ONE permitted mutation (E7 §5). Sets
  // effective_to together with all five closure-provenance columns
  // atomically. The DB trigger enforces the six-column NULL to non-NULL
  // move and byte-identity of everything else.
  async closeRestriction(
    input: CloseRestrictionInput,
    requestId: string,
  ): Promise<ClientTalentRestrictionView> {
    const now = new Date();

    const row = await this.findByIdScopedRow({
      tenant_id: input.tenant_id,
      client_company_id: input.client_company_id,
      talent_record_id: input.talent_record_id,
      id: input.restriction_id,
    });
    if (row === null) {
      throw new AramoError(
        'NOT_FOUND',
        'ClientTalentRestriction not found in this client-talent context',
        404,
        { requestId, details: { restriction_id: input.restriction_id } },
      );
    }

    // Already closed — closure is written ONCE (R4/R4b). A second close is
    // a conflict, not a silent no-op.
    if (row.effective_to !== null) {
      throw new AramoError(
        'RESTRICTION_ALREADY_CLOSED',
        'ClientTalentRestriction is already closed; closure provenance is written once and is immutable',
        409,
        { requestId, details: { restriction_id: input.restriction_id } },
      );
    }

    // Window validation.
    if (input.effective_to.getTime() < row.effective_from.getTime()) {
      throw this.windowInvalid(requestId, input.restriction_id, 'effective_to_before_effective_from');
    }
    if (row.scheduled_end_at !== null) {
      // Already naturally expired — no operational closure needed.
      if (row.scheduled_end_at.getTime() <= now.getTime()) {
        throw this.windowInvalid(requestId, input.restriction_id, 'already_naturally_expired');
      }
      // A close recorded to end AFTER the scheduled natural end is rejected
      // (historical correction is a separate ruling, not a weakened trigger).
      if (input.effective_to.getTime() > row.scheduled_end_at.getTime()) {
        throw this.windowInvalid(requestId, input.restriction_id, 'close_after_scheduled_end');
      }
    }

    let updated: ClientTalentRestrictionRow;
    try {
      updated = (await this.prisma.clientTalentRestriction.update({
        where: { id: input.restriction_id, tenant_id: input.tenant_id },
        data: {
          effective_to: input.effective_to,
          closed_at: now,
          closed_by: input.closed_by,
          close_reason_code: input.close_reason_code,
          close_source_system: input.close_source_system,
          close_source_reference: input.close_source_reference,
        },
      })) as ClientTalentRestrictionRow;
    } catch (err) {
      // The BEFORE UPDATE trigger raises check_violation on any non-close
      // mutation (reopen, partial closure, provenance edit). Surface as a
      // 409 conflict rather than a 500.
      if (isCheckViolation(err)) {
        throw new AramoError(
          'RESTRICTION_ALREADY_CLOSED',
          'ClientTalentRestriction close rejected by the immutability trigger (concurrent close or non-close mutation)',
          409,
          { requestId, details: { restriction_id: input.restriction_id } },
        );
      }
      throw err;
    }

    this.logger.log({
      event: 'client_talent_restriction_closed',
      tenant_id: input.tenant_id,
      client_company_id: input.client_company_id,
      talent_record_id: input.talent_record_id,
      restriction_id: input.restriction_id,
      close_reason_code: input.close_reason_code,
    });
    return projectView(updated, now);
  }

  // "Is this person restricted at THIS client, now?" — the active,
  // source-attributed records within the one client-talent context. NOT a
  // cross-client / cross-source count (E7 R2).
  async findCurrentForClientTalent(input: {
    tenant_id: string;
    client_company_id: string;
    talent_record_id: string;
  }): Promise<ClientTalentRestrictionView[]> {
    const now = new Date();
    const rows = (await this.prisma.clientTalentRestriction.findMany({
      where: {
        tenant_id: input.tenant_id,
        client_company_id: input.client_company_id,
        talent_record_id: input.talent_record_id,
        effective_from: { lte: now },
        AND: [
          { OR: [{ scheduled_end_at: null }, { scheduled_end_at: { gt: now } }] },
          { OR: [{ effective_to: null }, { effective_to: { gt: now } }] },
        ],
      },
      orderBy: { recorded_at: 'asc' },
    })) as ClientTalentRestrictionRow[];
    return rows.map((r) => projectView(r, now));
  }

  // Full source-attributed history within the one client-talent context
  // (active and ended). Never a cross-client surface.
  async findHistoryForClientTalent(input: {
    tenant_id: string;
    client_company_id: string;
    talent_record_id: string;
  }): Promise<ClientTalentRestrictionView[]> {
    const now = new Date();
    const rows = (await this.prisma.clientTalentRestriction.findMany({
      where: {
        tenant_id: input.tenant_id,
        client_company_id: input.client_company_id,
        talent_record_id: input.talent_record_id,
      },
      orderBy: { recorded_at: 'asc' },
    })) as ClientTalentRestrictionRow[];
    return rows.map((r) => projectView(r, now));
  }

  // ---- private, all client-and-talent- or identity-scoped ----

  private async findByAssertionIdentity(input: {
    tenant_id: string;
    source_system: SourceSystemValue;
    source_reference: string;
    restriction_type: RestrictionTypeValue;
  }): Promise<ClientTalentRestrictionRow | null> {
    const row = await this.prisma.clientTalentRestriction.findFirst({
      where: {
        tenant_id: input.tenant_id,
        source_system: input.source_system,
        source_reference: input.source_reference,
        restriction_type: input.restriction_type,
      },
    });
    return row === null ? null : (row as ClientTalentRestrictionRow);
  }

  private async findByIdScopedRow(input: {
    tenant_id: string;
    client_company_id: string;
    talent_record_id: string;
    id: string;
  }): Promise<ClientTalentRestrictionRow | null> {
    const row = await this.prisma.clientTalentRestriction.findFirst({
      where: {
        id: input.id,
        tenant_id: input.tenant_id,
        client_company_id: input.client_company_id,
        talent_record_id: input.talent_record_id,
      },
    });
    return row === null ? null : (row as ClientTalentRestrictionRow);
  }

  private windowInvalid(
    requestId: string,
    restriction_id: string,
    reason: string,
  ): AramoError {
    return new AramoError(
      'RESTRICTION_INVALID',
      `ClientTalentRestriction close window invalid: ${reason}`,
      422,
      { requestId, details: { restriction_id, reason } },
    );
  }
}

function isCheckViolation(err: unknown): boolean {
  // Prisma surfaces a raised trigger EXCEPTION as a known request error
  // whose meta.code is the Postgres SQLSTATE (23514 = check_violation), or
  // as P2010 raw-query failure. Duck-typed to avoid importing the
  // generated Prisma namespace.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (e.meta?.code === '23514') return true;
  return (
    typeof e.message === 'string' &&
    e.message.includes('append-and-close-only')
  );
}
