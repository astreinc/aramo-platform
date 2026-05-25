import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';

import {
  AI_DRAFT_EVENT_TYPES,
  type AiDraftEventType,
} from './dto/event-payloads.js';
import type { AiDraftEventView } from './dto/ai-draft-event.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// M5 PR-5 §4.9 — append-only repository for AiDraftEvent.
//
// Surface scope (closed): appendEvent (create-only) + 2 read methods
// (findById, findByTenantId) provided for completeness; the substrate
// is consumer-less at PR-5 so reads are exercised only in integration
// tests. The repository never exposes update / upsert / delete paths;
// the DB-level immutability trigger
// (ai_draft.ai_draft_event_immutable_trigger) provides defense in
// depth at the data layer.
//
// Logging discipline per Ruling 7: structured INFO entries log
// event_type + tenant_id + id only. event_payload contents (which may
// contain hashes that are themselves derived from possibly-sensitive
// inputs) are NEVER logged at this layer.

export interface AppendEventInput {
  id: string;
  tenant_id: string;
  event_type: AiDraftEventType;
  event_payload: unknown;
}

interface AiDraftEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

function projectView(row: AiDraftEventRow): AiDraftEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    event_type: row.event_type as AiDraftEventType,
    event_payload: row.event_payload,
    created_at: row.created_at,
  };
}

@Injectable()
export class AiDraftRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('AiDraftRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  async appendEvent(input: AppendEventInput): Promise<AiDraftEventView> {
    if (!AI_DRAFT_EVENT_TYPES.includes(input.event_type)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `unknown ai-draft event_type: ${input.event_type}`,
        400,
        {
          requestId: 'ai-draft-repository',
          details: { field: 'event_type', value: input.event_type },
        },
      );
    }
    const startedAt = Date.now();
    this.logger.log({
      event: 'ai_draft_event.append_started',
      tenant_id: input.tenant_id,
      ai_draft_event_id: input.id,
      event_type: input.event_type,
    });
    const created = await this.prisma.aiDraftEvent.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        event_type: input.event_type,
        event_payload: input.event_payload as never,
        created_at: new Date(),
      },
    });
    const view = projectView(created as AiDraftEventRow);
    this.logger.log({
      event: 'ai_draft_event.appended',
      tenant_id: view.tenant_id,
      ai_draft_event_id: view.id,
      event_type: view.event_type,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findById(id: string): Promise<AiDraftEventView | null> {
    const row = await this.prisma.aiDraftEvent.findUnique({ where: { id } });
    return row === null ? null : projectView(row as AiDraftEventRow);
  }

  async findByTenantId(tenant_id: string): Promise<AiDraftEventView[]> {
    const rows = await this.prisma.aiDraftEvent.findMany({
      where: { tenant_id },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return (rows as AiDraftEventRow[]).map((r) => projectView(r));
  }
}
