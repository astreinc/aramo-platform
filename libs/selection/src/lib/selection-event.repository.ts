import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';

import type { SelectionEventTypeValue } from './selection-event.js';
import type { TalentSelectionEventView } from './dto/talent-selection-event.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentSelectionEvent model (M5 PR-2 directive
// §4.5; amended Ruling 3 — 5 methods including findByTenantAndId for
// cross-schema validator use).
//
// Surface scope (closed):
//   - appendEvent (WRITE; create-only — never update/upsert/delete)
//   - findById (READ)
//   - findBySelectionId (READ)
//   - findByTenantAndSelectionId (READ; tenant-scoped)
//   - findByTenantAndId (READ; tenant-scoped — consumed by
//     EvidenceRepository.buildPackage cross-schema validator at
//     M5 PR-2 §4.8)
//
// Append-only architecture: appendEvent is the sole write path. The
// table's BEFORE UPDATE trigger
// (selection.reject_selection_event_update) enforces absolute
// immutability at the DB layer — even a deliberate prisma.update from
// outside this repository would be rejected by Postgres. Belt-and-
// suspenders alongside the trigger.
//
// Tenant isolation (Architecture §7.2): tenant-scoped methods filter
// by tenant_id in the WHERE clause. findById and findBySelectionId
// are unscoped lookups (PK / FK respectively) — caller is responsible
// for tenant assertion at consumer sites. The cross-schema validator
// at M5 PR-2 §4.8 uses findByTenantAndId, which enforces tenant
// scope at the repository layer.
//
// Observability (Plan v1.5 §M4 "observability per-PR standard from M4
// onward"; HK-PR-4 adoption): Style A constructor-DI AramoLogger via
// the 'SelectionEventRepositoryLogger' token wired in
// selection.module.ts. Structured INFO-level logging at entry +
// success/refusal/hit/miss paths.

export interface AppendEventInput {
  id: string;
  tenant_id: string;
  selection_id: string;
  event_type: SelectionEventTypeValue;
  event_payload: unknown;
}

interface TalentSelectionEventRow {
  id: string;
  tenant_id: string;
  selection_id: string;
  event_type: SelectionEventTypeValue;
  event_payload: unknown;
  created_at: Date;
}

function projectView(row: TalentSelectionEventRow): TalentSelectionEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    selection_id: row.selection_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    created_at: row.created_at,
  };
}

@Injectable()
export class SelectionEventRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('SelectionEventRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  async appendEvent(input: AppendEventInput): Promise<TalentSelectionEventView> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'selection_event.append_started',
      tenant_id: input.tenant_id,
      selection_id: input.selection_id,
      event_type: input.event_type,
    });
    const created = await this.prisma.talentSelectionEvent.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        selection_id: input.selection_id,
        event_type: input.event_type,
        event_payload: input.event_payload as never,
      },
    });
    const view = projectView(created as TalentSelectionEventRow);
    this.logger.log({
      event: 'selection_event.appended',
      tenant_id: view.tenant_id,
      selection_id: view.selection_id,
      selection_event_id: view.id,
      event_type: view.event_type,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findById(id: string): Promise<TalentSelectionEventView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentSelectionEvent.findUnique({
      where: { id },
    });
    const view = row === null ? null : projectView(row as TalentSelectionEventRow);
    this.logger.log({
      event: 'selection_event.findById',
      selection_event_id: id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findBySelectionId(
    selection_id: string,
  ): Promise<TalentSelectionEventView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentSelectionEvent.findMany({
      where: { selection_id },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const views = (rows as TalentSelectionEventRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'selection_event.findBySelectionId',
      selection_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndSelectionId(input: {
    tenant_id: string;
    selection_id: string;
  }): Promise<TalentSelectionEventView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentSelectionEvent.findMany({
      where: {
        tenant_id: input.tenant_id,
        selection_id: input.selection_id,
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const views = (rows as TalentSelectionEventRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'selection_event.findByTenantAndSelectionId',
      tenant_id: input.tenant_id,
      selection_id: input.selection_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndId(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentSelectionEventView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentSelectionEvent.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    const view = row === null ? null : projectView(row as TalentSelectionEventRow);
    this.logger.log({
      event: 'selection_event.findByTenantAndId',
      tenant_id: input.tenant_id,
      selection_event_id: input.id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }
}
