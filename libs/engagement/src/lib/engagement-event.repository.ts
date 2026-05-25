import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';

import type { EngagementEventTypeValue } from './engagement-event.js';
import type { TalentEngagementEventView } from './dto/talent-engagement-event.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentEngagementEvent model (M5 PR-2 directive
// §4.5; amended Ruling 3 — 5 methods including findByTenantAndId for
// cross-schema validator use).
//
// Surface scope (closed):
//   - appendEvent (WRITE; create-only — never update/upsert/delete)
//   - findById (READ)
//   - findByEngagementId (READ)
//   - findByTenantAndEngagementId (READ; tenant-scoped)
//   - findByTenantAndId (READ; tenant-scoped — consumed by
//     EvidenceRepository.buildPackage cross-schema validator at
//     M5 PR-2 §4.8)
//
// Append-only architecture: appendEvent is the sole write path. The
// table's BEFORE UPDATE trigger
// (engagement.reject_engagement_event_update) enforces absolute
// immutability at the DB layer — even a deliberate prisma.update from
// outside this repository would be rejected by Postgres. Belt-and-
// suspenders alongside the trigger.
//
// Tenant isolation (Architecture §7.2): tenant-scoped methods filter
// by tenant_id in the WHERE clause. findById and findByEngagementId
// are unscoped lookups (PK / FK respectively) — caller is responsible
// for tenant assertion at consumer sites. The cross-schema validator
// at M5 PR-2 §4.8 uses findByTenantAndId, which enforces tenant
// scope at the repository layer.
//
// Observability (Plan v1.5 §M4 "observability per-PR standard from M4
// onward"; HK-PR-4 adoption): Style A constructor-DI AramoLogger via
// the 'EngagementEventRepositoryLogger' token wired in
// engagement.module.ts. Structured INFO-level logging at entry +
// success/refusal/hit/miss paths.

export interface AppendEventInput {
  id: string;
  tenant_id: string;
  engagement_id: string;
  event_type: EngagementEventTypeValue;
  event_payload: unknown;
}

interface TalentEngagementEventRow {
  id: string;
  tenant_id: string;
  engagement_id: string;
  event_type: EngagementEventTypeValue;
  event_payload: unknown;
  created_at: Date;
}

function projectView(row: TalentEngagementEventRow): TalentEngagementEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    engagement_id: row.engagement_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    created_at: row.created_at,
  };
}

@Injectable()
export class EngagementEventRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('EngagementEventRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  async appendEvent(input: AppendEventInput): Promise<TalentEngagementEventView> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'engagement_event.append_started',
      tenant_id: input.tenant_id,
      engagement_id: input.engagement_id,
      event_type: input.event_type,
    });
    const created = await this.prisma.talentEngagementEvent.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
        event_type: input.event_type,
        event_payload: input.event_payload as never,
      },
    });
    const view = projectView(created as TalentEngagementEventRow);
    this.logger.log({
      event: 'engagement_event.appended',
      tenant_id: view.tenant_id,
      engagement_id: view.engagement_id,
      engagement_event_id: view.id,
      event_type: view.event_type,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findById(id: string): Promise<TalentEngagementEventView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentEngagementEvent.findUnique({
      where: { id },
    });
    const view = row === null ? null : projectView(row as TalentEngagementEventRow);
    this.logger.log({
      event: 'engagement_event.findById',
      engagement_event_id: id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByEngagementId(
    engagement_id: string,
  ): Promise<TalentEngagementEventView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentEngagementEvent.findMany({
      where: { engagement_id },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const views = (rows as TalentEngagementEventRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'engagement_event.findByEngagementId',
      engagement_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndEngagementId(input: {
    tenant_id: string;
    engagement_id: string;
  }): Promise<TalentEngagementEventView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentEngagementEvent.findMany({
      where: {
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const views = (rows as TalentEngagementEventRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'engagement_event.findByTenantAndEngagementId',
      tenant_id: input.tenant_id,
      engagement_id: input.engagement_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndId(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentEngagementEventView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentEngagementEvent.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    const view = row === null ? null : projectView(row as TalentEngagementEventRow);
    this.logger.log({
      event: 'engagement_event.findByTenantAndId',
      tenant_id: input.tenant_id,
      engagement_event_id: input.id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }
}
