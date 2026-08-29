import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';

import type { AppendSubmittalEventInput } from './dto/append-submittal-event.input.js';
import type {
  SubmittalEventTypeValue,
  TalentSubmittalEventView,
} from './dto/talent-submittal-event.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentSubmittalEvent model (M5 PR-8b1 §4.3).
//
// Surface scope (closed; mirrors M5 PR-2 SelectionEventRepository
// 5-method shape per Lead-Q-PR-8b1-A5 full PR-2 mirror):
//   - appendEvent (WRITE; create-only — never update/upsert/delete)
//   - findById (READ)
//   - findBySubmittalId (READ)
//   - findByTenantAndSubmittalId (READ; tenant-scoped)
//   - findByTenantAndId (READ; tenant-scoped — cross-schema validator
//     consumer slot reserved for PR-8b2+ wire-in)
//
// Append-only architecture: appendEvent is the sole write path. The
// table's BEFORE UPDATE trigger
// (selection.reject_submittal_event_update) enforces absolute
// immutability at the DB layer — even a deliberate prisma.update from
// outside this repository would be rejected by Postgres. Belt-and-
// suspenders alongside the trigger.
//
// Tenant isolation (Architecture §7.2): tenant-scoped methods filter
// by tenant_id in the WHERE clause. findById and findBySubmittalId
// are unscoped lookups (PK / FK respectively) — caller is responsible
// for tenant assertion at consumer sites. The cross-schema validator
// slot at findByTenantAndId enforces tenant scope at the repository
// layer for PR-8b2+ consumers.
//
// Observability (Plan v1.5 §M4 "observability per-PR standard from M4
// onward"; HK-PR-4 adoption): Style A constructor-DI AramoLogger via
// the 'TalentSubmittalEventRepositoryLogger' token wired in
// submittal.module.ts. Structured INFO-level logging at entry +
// success/hit/miss paths.
//
// DI pattern per Lead-Q-PR-8b1-A2: direct PrismaService injection (no
// token-based injection); matches libs/selection/src/lib/
// selection-event.repository.ts:71-75 precedent.

interface TalentSubmittalEventRow {
  id: string;
  tenant_id: string;
  submittal_id: string;
  event_type: SubmittalEventTypeValue;
  event_payload: unknown;
  created_at: Date;
}

// Lane 2 / L2-E (SB-5 / D-4) — the authoritative submitted-transition-history
// grain. The FIRST canonical `state_transition → submitted_to_ats` event per
// (talent, requisition) grain, carrying the linked pipeline_id (for time-to-submit
// joins) and the transition instant. DURABLE: keyed on the immutable EVENT, not the
// mutable record.state, so it survives the record's later confirmed/revoked
// transitions — reproducing the retired Pipeline mirror (which never un-set the
// status). requisition_id = the record's job_id.
export interface SubmittedGrainRow {
  talent_id: string;
  requisition_id: string;
  pipeline_id: string | null;
  first_submitted_at: Date;
}

function projectView(row: TalentSubmittalEventRow): TalentSubmittalEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    submittal_id: row.submittal_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    created_at: row.created_at,
  };
}

@Injectable()
export class TalentSubmittalEventRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('TalentSubmittalEventRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  async appendEvent(input: AppendSubmittalEventInput): Promise<TalentSubmittalEventView> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_event.append_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
      event_type: input.event_type,
    });
    const created = await this.prisma.talentSubmittalEvent.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        event_type: input.event_type,
        event_payload: input.event_payload as never,
      },
    });
    const view = projectView(created as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_event.appended',
      tenant_id: view.tenant_id,
      submittal_id: view.submittal_id,
      submittal_event_id: view.id,
      event_type: view.event_type,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findById(id: string): Promise<TalentSubmittalEventView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentSubmittalEvent.findUnique({
      where: { id },
    });
    const view = row === null ? null : projectView(row as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_event.findById',
      submittal_event_id: id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findBySubmittalId(
    submittal_id: string,
  ): Promise<TalentSubmittalEventView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentSubmittalEvent.findMany({
      where: { submittal_id },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const views = (rows as TalentSubmittalEventRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'submittal_event.findBySubmittalId',
      submittal_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndSubmittalId(input: {
    tenant_id: string;
    submittal_id: string;
  }): Promise<TalentSubmittalEventView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentSubmittalEvent.findMany({
      where: {
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const views = (rows as TalentSubmittalEventRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'submittal_event.findByTenantAndSubmittalId',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndId(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentSubmittalEventView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentSubmittalEvent.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    const view = row === null ? null : projectView(row as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_event.findByTenantAndId',
      tenant_id: input.tenant_id,
      submittal_event_id: input.id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  // Lane 2 / L2-E (SB-5) — the authoritative submitted-history read the L2-E
  // repoints consume (reporting via a reporting-owned port; apps/api enrichment
  // directly). Bulk-oriented: ONE tenant-scoped query returns the first
  // submitted_to_ats transition per (talent, requisition) grain. DISTINCT ON picks
  // the earliest event per grain (carrying that submittal's pipeline_id); the
  // optional `since` filters on the FIRST transition instant (outer WHERE on the
  // derived value — never on the raw event, which would wrongly admit a grain whose
  // true-first submitted transition predates the window). No event-table denormalization
  // (Architect ruling): the grain lives on TalentSubmittalRecord, JOINed here.
  async findFirstSubmittedByGrain(input: {
    tenant_id: string;
    requisition_ids?: readonly string[];
    talent_ids?: readonly string[];
    since?: Date;
  }): Promise<SubmittedGrainRow[]> {
    const startedAt = Date.now();
    const params: unknown[] = [input.tenant_id];
    const innerClauses: string[] = [];
    if (input.requisition_ids !== undefined) {
      params.push([...input.requisition_ids]);
      innerClauses.push(`AND sr.job_id = ANY($${params.length}::uuid[])`);
    }
    if (input.talent_ids !== undefined) {
      params.push([...input.talent_ids]);
      innerClauses.push(`AND sr.talent_id = ANY($${params.length}::uuid[])`);
    }
    let outerWhere = '';
    if (input.since !== undefined) {
      params.push(input.since);
      outerWhere = `WHERE g.first_submitted_at >= $${params.length}::timestamptz`;
    }
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        talent_id: string;
        requisition_id: string;
        pipeline_id: string | null;
        first_submitted_at: Date;
      }>
    >(
      `SELECT * FROM (
         SELECT DISTINCT ON (sr.talent_id, sr.job_id)
                sr.talent_id            AS talent_id,
                sr.job_id               AS requisition_id,
                sr.pipeline_id          AS pipeline_id,
                se.created_at           AS first_submitted_at
           FROM submittal."TalentSubmittalEvent" se
           JOIN submittal."TalentSubmittalRecord" sr
             ON sr.id = se.submittal_id AND sr.tenant_id = se.tenant_id
          WHERE se.tenant_id = $1::uuid
            AND se.event_type = 'state_transition'
            AND se.event_payload->>'to_state' = 'submitted_to_ats'
            ${innerClauses.join('\n            ')}
          ORDER BY sr.talent_id, sr.job_id, se.created_at ASC, se.id ASC
       ) g
       ${outerWhere}`,
      ...params,
    );
    this.logger.log({
      event: 'submittal_event.findFirstSubmittedByGrain',
      tenant_id: input.tenant_id,
      result_count: rows.length,
      latency_ms: Date.now() - startedAt,
    });
    return rows.map((r) => ({
      talent_id: r.talent_id,
      requisition_id: r.requisition_id,
      pipeline_id: r.pipeline_id,
      first_submitted_at: r.first_submitted_at,
    }));
  }
}
