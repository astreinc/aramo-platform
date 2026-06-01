import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// M6 PR-2 — engagement-schema outbox repository.
//
// Mirrors libs/consent OutboxPublisherRepository verbatim (read + bulk-
// mark-published; no insertInTx — emission is inline tx.outboxEvent.create
// inside each EngagementRepository write-method `$transaction`).
//
// findUnpublishedEvents returns up to `limit` rows with `published_at IS
// NULL`, ordered by created_at ASC so the publisher emits in event order.
// markPublished bulk-updates published_at = now() for the supplied ids.
//
// Consumed by libs/outbox-publisher (M6 PR-2 §4 — the publisher relocates
// to its own leaf lib to break the would-be consent → engagement cycle).

export interface UnpublishedOutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

@Injectable()
export class EngagementOutboxRepository {
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
