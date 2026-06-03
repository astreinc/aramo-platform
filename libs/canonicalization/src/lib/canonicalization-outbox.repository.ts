import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// T2-2a — canonicalization-schema outbox repository.
//
// Mirrors libs/submittal.SubmittalOutboxRepository + libs/consent
// .OutboxPublisherRepository verbatim — findUnpublishedEvents + bulk
// markPublished, no insertInTx (emission is inline tx.outboxEvent.create
// inside CanonicalizationRepository.canonicalize's $transaction; the
// outbox invariant — the event must commit atomically with the state
// change).
//
// Consumed by libs/outbox-publisher at T2-2b (the publisher's 4th-schema
// drain extension). T2-2a EXPORTS this repository but does NOT inject it
// anywhere here; T2-2b adds the OutboxPublisherProcessor edge that picks
// it up via @aramo/canonicalization.
//
// Until T2-2b lights the drain, talent.canonicalized events accumulate
// in canonicalization.OutboxEvent with published_at = NULL. Harmless
// (no consumer yet) and bounded (the row count grows at the canonicalize
// rate). T2-2b removes that backlog on first tick.

export interface UnpublishedOutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

@Injectable()
export class CanonicalizationOutboxRepository {
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

  async markPublished(input: {
    event_ids: readonly string[];
    published_at: Date;
  }): Promise<number> {
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
