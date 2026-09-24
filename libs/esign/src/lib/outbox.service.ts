import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  EVENT_PUBLISHER_PORT,
  type EsignDomainEvent,
  type EventPublisherPort,
} from './ports/event-publisher.port.js';

// DOC-4 (R-4-7) — transactional-outbox producer + drain. produce() enqueues an
// OutboxEvent row (durable, replayable); drain() publishes unpublished rows via
// the EventPublisherPort and stamps published_at. Republish is idempotent: a
// published row is never re-emitted, and the downstream consumer is itself
// idempotent (apps/api DocumentIdempotencyService), so at-least-once delivery
// never creates duplicate legal/evidence records.

// A Prisma transaction client (or the base client) — the enqueue may run inside
// the completion transaction for atomicity with the state change.
type TxClient = { outboxEvent: PrismaService['outboxEvent'] };

@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(EVENT_PUBLISHER_PORT) private readonly publisher?: EventPublisherPort,
  ) {}

  async enqueue(tx: TxClient, event: EsignDomainEvent): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        id: randomUUID(),
        tenant_id: event.tenant_id,
        event_type: event.event_type,
        event_payload: {
          envelope_id: event.envelope_id,
          correlation_id: event.correlation_id,
          artifact_refs: event.artifact_refs,
        },
      },
    });
  }

  // Publish all unpublished rows; returns the number published. No-op (returns 0)
  // when no publisher is bound (DARK/unwired).
  async drain(limit = 100): Promise<number> {
    if (this.publisher === undefined) return 0;
    const rows = await this.prisma.outboxEvent.findMany({
      where: { published_at: null },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    let count = 0;
    for (const row of rows) {
      const payload = row.event_payload as {
        envelope_id: string;
        correlation_id: string;
        artifact_refs: { executed_document_ids: string[]; has_certificate: boolean };
      };
      await this.publisher.publish({
        event_type: row.event_type,
        tenant_id: row.tenant_id,
        envelope_id: payload.envelope_id,
        correlation_id: payload.correlation_id,
        artifact_refs: payload.artifact_refs,
      });
      await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { published_at: new Date() } });
      count += 1;
    }
    return count;
  }
}
