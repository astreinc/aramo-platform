import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Lane 2 / L2-F (F1) — client_selection-schema outbox repository. Mirrors the
// submittal/pipeline outbox repos verbatim (read + bulk-mark-published; emission is
// inline `tx.outboxEvent.create` inside the ClientSelectionProcessRepository
// transitions). Consumed by libs/outbox-publisher as the 7th drained namespace.

export interface UnpublishedOutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

@Injectable()
export class ClientSelectionOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUnpublishedEvents(input: { limit: number }): Promise<UnpublishedOutboxEvent[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { published_at: null },
      orderBy: { created_at: 'asc' },
      take: input.limit,
    });
    return rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      event_type: row.event_type,
      event_payload: row.event_payload,
      created_at: row.created_at,
    }));
  }

  async markPublished(input: { event_ids: readonly string[]; published_at: Date }): Promise<number> {
    if (input.event_ids.length === 0) {
      return 0;
    }
    const result = await this.prisma.outboxEvent.updateMany({
      where: { id: { in: [...input.event_ids] } },
      data: { published_at: input.published_at },
    });
    return result.count;
  }
}
