import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { backoffMs } from './outbox-backoff.js';
import { toLifecycleEvent } from './ports/lifecycle-event.js';
import { WEBHOOK_DELIVERY_PORT, type WebhookDeliveryPort } from './ports/webhook-delivery.port.js';

// E-Sign OC v2 — the canonical outbound-delivery drainer. E-Sign owns reliable
// lifecycle-event delivery (Independent-Digital-Signature-Platform Directive
// sections 8, 28), so this service claims due, unpublished outbox rows, delivers
// each generic event through the webhook port, and durably records the outcome:
// success stamps published_at; failure advances attempt_count + a backoff
// next_attempt_at + a bounded last_error_code.
//
// Safe against overlapping worker ticks and process restarts: a claimed batch is
// LEASED (next_attempt_at pushed to now+lease) before delivery, so a re-entrant
// tick or a mid-flight crash does not re-grab the same rows until the lease
// lapses. Delivery is at-least-once; the Core consumer dedups on event_id and the
// write-back is idempotent, so a rare double-delivery has no duplicate effect.

export interface DeliveryBatchResult {
  claimed: number;
  delivered: number;
  failed: number;
}

// Bounded, sanitized diagnostic — enforces the VarChar(64) column bound and keeps
// arbitrary response text out of the database.
function sanitizeErrorCode(code: string | undefined): string | null {
  if (code === undefined || code === '') return null;
  return code.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
}

@Injectable()
export class OutboxDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WEBHOOK_DELIVERY_PORT) private readonly delivery?: WebhookDeliveryPort,
  ) {}

  // Claim + deliver one due batch. No-op (all zero) when no delivery port is bound.
  async deliverDueBatch(opts?: { now?: Date; limit?: number; leaseMs?: number }): Promise<DeliveryBatchResult> {
    if (this.delivery === undefined) return { claimed: 0, delivered: 0, failed: 0 };
    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? 20;
    const leaseMs = opts?.leaseMs ?? 60_000;

    const due = await this.prisma.outboxEvent.findMany({
      where: { published_at: null, OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    if (due.length === 0) return { claimed: 0, delivered: 0, failed: 0 };

    // Lease the batch so an overlapping tick / mid-flight restart cannot re-claim
    // these rows until the lease expires (restart safety). Only leases rows still
    // unpublished.
    const leaseUntil = new Date(now.getTime() + leaseMs);
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: due.map((r) => r.id) }, published_at: null },
      data: { next_attempt_at: leaseUntil },
    });

    let delivered = 0;
    let failed = 0;
    for (const row of due) {
      let result: { ok: boolean; error_code?: string };
      try {
        result = await this.delivery.deliver(toLifecycleEvent(row));
      } catch {
        result = { ok: false, error_code: 'DELIVERY_THREW' };
      }
      const stamp = new Date();
      if (result.ok) {
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { published_at: stamp, last_attempt_at: stamp, attempt_count: { increment: 1 }, last_error_code: null },
        });
        delivered += 1;
      } else {
        const nextAttempts = row.attempt_count + 1;
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            attempt_count: { increment: 1 },
            last_attempt_at: stamp,
            last_error_code: sanitizeErrorCode(result.error_code),
            next_attempt_at: new Date(stamp.getTime() + backoffMs(nextAttempts)),
          },
        });
        failed += 1;
      }
    }
    return { claimed: due.length, delivered, failed };
  }
}
