import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// M5 PR-11 §4.3 — outbox publisher repository.
//
// LIGHT-SCOPE per audit Axis B Lead-Q-B1=(a) disposition + ADR-0018
// Decision 4: PR-11 publishes only libs/consent.OutboxEvent rows. Other
// domain schemas do NOT have outbox tables yet (multi-schema expansion
// deferred to M6).
//
// findUnpublishedEvents returns up to `limit` rows with `published_at IS NULL`,
// ordered by created_at ASC so the publisher emits in event-order.
// markPublished bulk-updates published_at = now() for the supplied ids.

export interface UnpublishedOutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

@Injectable()
export class OutboxPublisherRepository {
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
