import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Track 3 / E1-c — the placement schema's outbox drain surface, consumed by
// libs/outbox-publisher (house pattern, mirrors EngagementOutboxRepository).
// findUnpublishedEvents returns up to `limit` rows with published_at IS NULL,
// oldest first; markPublished bulk-stamps published_at (the ONLY column the
// immutability trigger permits an OutboxEvent UPDATE to change).

export interface UnpublishedOutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

@Injectable()
export class PlacementOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUnpublishedEvents(input: { limit: number }): Promise<UnpublishedOutboxEvent[]> {
    const rows = (await this.prisma.outboxEvent.findMany({
      where: { published_at: null },
      orderBy: { created_at: 'asc' },
      take: input.limit,
    })) as OutboxRow[];
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      event_type: r.event_type,
      event_payload: r.event_payload,
      created_at: r.created_at,
    }));
  }

  async markPublished(input: { event_ids: readonly string[]; published_at: Date }): Promise<number> {
    if (input.event_ids.length === 0) return 0;
    const result = await this.prisma.outboxEvent.updateMany({
      where: { id: { in: [...input.event_ids] }, published_at: null },
      data: { published_at: input.published_at },
    });
    return result.count;
  }
}
