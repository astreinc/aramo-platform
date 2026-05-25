import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';

import type { EngagementStateValue } from './engagement-state.js';
import type { TalentJobEngagementView } from './dto/talent-job-engagement.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentJobEngagement model (M5 PR-1 Directive v1.0
// §4.4; Amendment v1.1 unchanged for this section).
//
// Surface scope (closed, READ-ONLY at PR-1 per Directive Ruling 3):
//   - findById
//   - findByTenantAndId
//   - findByTenantAndTalent
//   - findByTenantAndRequisition
//
// NO write methods at PR-1. `createEngagement` + `transitionState`
// write methods are M5 PR-3 territory (engagement-creation write path).
// Belt-and-suspenders alongside the column-scoped database trigger
// installed by libs/engagement/prisma/migrations/<ts>_init_engagement_model.
//
// Tenant isolation (Architecture §7.2): three of the four methods take
// tenant_id explicitly. `findById` is the exception (UUID lookup; tenant
// assertion is the caller's responsibility at the consumer site —
// mirrors evidence/examination findById precedent for PK lookups). All
// tenant-scoped methods use prisma.findFirst / findMany with the
// tenant_id WHERE clause.
//
// Cross-schema read validation (Architecture §7.3 — UUID-only, no FK):
// `examination_id` and `requisition_id` are UUID-only references with
// no FK constraint. Read methods do not cross schemas; downstream
// consumers (M5 PR-3+) compose engagement reads with examination /
// requisition reads at the application layer.
//
// Observability (Plan v1.5 §M4 "observability per-PR standard from M4
// onward"; HK-PR-4 adoption): Style A constructor-DI AramoLogger,
// injected via the 'EngagementRepositoryLogger' token wired in
// engagement.module.ts. Structured INFO-level logging at entry +
// hit/miss/result-count paths.

interface TalentJobEngagementRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  examination_id: string | null;
  state: EngagementStateValue;
  created_at: Date;
}

function projectView(row: TalentJobEngagementRow): TalentJobEngagementView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    talent_id: row.talent_id,
    requisition_id: row.requisition_id,
    examination_id: row.examination_id,
    state: row.state,
    created_at: row.created_at,
  };
}

@Injectable()
export class EngagementRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('EngagementRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  async findById(id: string): Promise<TalentJobEngagementView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentJobEngagement.findUnique({
      where: { id },
    });
    const view = row === null ? null : projectView(row as TalentJobEngagementRow);
    this.logger.log({
      event: 'engagement.findById',
      engagement_id: id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByTenantAndId(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentJobEngagementView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentJobEngagement.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    const view = row === null ? null : projectView(row as TalentJobEngagementRow);
    this.logger.log({
      event: 'engagement.findByTenantAndId',
      tenant_id: input.tenant_id,
      engagement_id: input.id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByTenantAndTalent(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentJobEngagementView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentJobEngagement.findMany({
      where: { tenant_id: input.tenant_id, talent_id: input.talent_id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const views = (rows as TalentJobEngagementRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'engagement.findByTenantAndTalent',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndRequisition(input: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<TalentJobEngagementView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentJobEngagement.findMany({
      where: {
        tenant_id: input.tenant_id,
        requisition_id: input.requisition_id,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const views = (rows as TalentJobEngagementRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'engagement.findByTenantAndRequisition',
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }
}
