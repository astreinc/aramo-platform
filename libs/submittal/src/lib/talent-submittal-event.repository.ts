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
// Surface scope (closed; mirrors M5 PR-2 EngagementEventRepository
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
// (engagement.reject_submittal_event_update) enforces absolute
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
// token-based injection); matches libs/engagement/src/lib/
// engagement-event.repository.ts:71-75 precedent.

interface TalentSubmittalEventRow {
  id: string;
  tenant_id: string;
  submittal_id: string;
  event_type: SubmittalEventTypeValue;
  event_payload: unknown;
  created_at: Date;
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
}
