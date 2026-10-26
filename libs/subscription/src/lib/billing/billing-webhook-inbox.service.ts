import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';
import { assertProductKey, type ProductKey } from '../product-registry.js';

import { BILLING_PROVIDER_PORT, type BillingProviderPort, type VerifiedBillingEvent } from './billing-provider.port.js';
import { BILLING_COMMAND_LEASE_MS, billingCommandBackoffMs } from './billing-provider-command.js';
import { SubscriptionLifecycleService, type WebhookResult } from './subscription-lifecycle.service.js';

// CCP-C1 (PBD §5.2 row C1 "webhook inbox"; Conversion Rule C-22) — the durable receipt of every
// VERIFIED provider event, before it is processed.
//
//   receive  the signature is already verified by the caller (the provider adapter). The verified
//            ENVELOPE (event id, type, created, subscription / session ref) is stored — never the
//            raw payload: processing always re-fetches provider state. The row is claimed with a
//            lease (one autocommit statement) and processed through SubscriptionLifecycleService
//            .handleEvent, unchanged: the A6 hold, the BillingEvent dedupe and outcome evidence,
//            and (C1) the command confirmation all run there. A failure is recorded FAILED and
//            rethrown (the route answers 5xx so the provider redelivers); nothing is dropped.
//   duplicate / concurrent delivery  the second delivery finds the row PROCESSED, or PROCESSING
//            under a live lease, and answers DUPLICATE without processing.
//   drain    the worker re-processes RECEIVED rows left by a crash, FAILED rows whose backoff has
//            elapsed (up to INBOX_MAX_AUTOMATIC_ATTEMPTS; a provider redelivery may always retry),
//            and PROCESSING rows whose lease expired.

/** Automatic drain attempts before a FAILED row waits for a provider redelivery or an operator. */
export const INBOX_MAX_AUTOMATIC_ATTEMPTS = 10;

export interface BillingWebhookInboxRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  event_created_at: Date;
  subscription_ref: string | null;
  checkout_session_ref: string | null;
  /** CCP-C4 — the provider object the event concerns (a billing adjustment's), or null. */
  object_ref: string | null;
  product_key: string;
  status: string;
  attempts: number;
  lease_until: Date | null;
  next_attempt_at: Date | null;
  outcome: string | null;
  detail: string | null;
  last_error: string | null;
  received_at: Date;
  processed_at: Date | null;
  updated_at: Date;
}

export const BILLING_WEBHOOK_INBOX_STATUSES = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED'] as const;
export type BillingWebhookInboxStatus = (typeof BILLING_WEBHOOK_INBOX_STATUSES)[number];

export class BillingWebhookInboxQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingWebhookInboxQueryError';
  }
}

export interface DrainTally {
  claimed: number;
  processed: number;
  failed: number;
  results: WebhookResult[];
}

function encodeInboxCursor(at: Date, id: string, filter: string): string {
  return Buffer.from(JSON.stringify({ r: at.toISOString(), i: id, f: filter }), 'utf8').toString('base64url');
}

function decodeInboxCursor(cursor: string, filter: string): { at: Date; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { r?: unknown; i?: unknown; f?: unknown };
    const at = typeof v.r === 'string' ? new Date(v.r) : null;
    if (at === null || Number.isNaN(at.getTime()) || typeof v.i !== 'string' || v.f !== filter) return null;
    return { at, id: v.i };
  } catch {
    return null;
  }
}

@Injectable()
export class BillingWebhookInboxService {
  private readonly log = new Logger(BillingWebhookInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {}

  /** Record a verified event durably, then process it (at most one processor at a time). */
  async receive(evt: VerifiedBillingEvent, product_key: ProductKey, at: Date = new Date()): Promise<WebhookResult> {
    assertProductKey(product_key);
    const provider = this.billing.provider;
    await this.prisma.billingWebhookInbox.createMany({
      data: [
        {
          id: uuidv7(),
          provider,
          provider_event_id: evt.id,
          event_type: evt.type,
          event_created_at: evt.created,
          subscription_ref: evt.subscription_ref,
          checkout_session_ref: evt.checkout_session_ref ?? null,
          // CCP-C4 — written only when present (a narrowed pre-C4 schema keeps working).
          ...(evt.object_ref !== undefined && evt.object_ref !== null ? { object_ref: evt.object_ref } : {}),
          product_key,
          status: 'RECEIVED',
          attempts: 0,
          received_at: at,
          updated_at: at,
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.claim({ provider, provider_event_id: evt.id }, at);
    if (row === null) return { outcome: 'DUPLICATE', tenant_id: null };
    return this.process(row, at);
  }

  /** Re-process what a crash or a failure left behind (worker). Never throws per row. */
  async drain(product_key: ProductKey, at: Date = new Date(), limit = 25): Promise<DrainTally> {
    assertProductKey(product_key);
    const tally: DrainTally = { claimed: 0, processed: 0, failed: 0, results: [] };
    for (let i = 0; i < limit; i += 1) {
      const row = await this.claim({ product_key }, at);
      if (row === null) break;
      tally.claimed += 1;
      try {
        tally.results.push(await this.process(row, at));
        tally.processed += 1;
      } catch {
        tally.failed += 1;
      }
    }
    return tally;
  }

  /**
   * One autocommit statement: RECEIVED / due FAILED / lease-expired PROCESSING → PROCESSING.
   * By event (a delivery: a FAILED row is retried whatever its backoff) or by product (the drain).
   */
  private async claim(by: { provider: string; provider_event_id: string } | { product_key: string }, at: Date): Promise<BillingWebhookInboxRow | null> {
    const lease = new Date(at.getTime() + BILLING_COMMAND_LEASE_MS);
    const rows =
      'provider_event_id' in by
        ? await this.prisma.$queryRaw<BillingWebhookInboxRow[]>`
            UPDATE "subscription"."BillingWebhookInbox" i
               SET "status" = 'PROCESSING', "attempts" = i."attempts" + 1, "lease_until" = ${lease}, "updated_at" = ${at}
             WHERE i."provider" = ${by.provider} AND i."provider_event_id" = ${by.provider_event_id}
               AND (i."status" IN ('RECEIVED', 'FAILED') OR (i."status" = 'PROCESSING' AND i."lease_until" <= ${at}))
            RETURNING i.*`
        : await this.prisma.$queryRaw<BillingWebhookInboxRow[]>`
            UPDATE "subscription"."BillingWebhookInbox" i
               SET "status" = 'PROCESSING', "attempts" = i."attempts" + 1, "lease_until" = ${lease}, "updated_at" = ${at}
             WHERE i."id" = (
               SELECT q."id" FROM "subscription"."BillingWebhookInbox" q
                WHERE q."product_key" = ${by.product_key}
                  AND (q."status" = 'RECEIVED'
                       OR (q."status" = 'FAILED' AND q."attempts" < ${INBOX_MAX_AUTOMATIC_ATTEMPTS} AND (q."next_attempt_at" IS NULL OR q."next_attempt_at" <= ${at}))
                       OR (q."status" = 'PROCESSING' AND q."lease_until" <= ${at}))
                ORDER BY q."received_at", q."id"
                LIMIT 1
                FOR UPDATE SKIP LOCKED)
            RETURNING i.*`;
    return rows[0] ?? null;
  }

  private async process(row: BillingWebhookInboxRow, at: Date): Promise<WebhookResult> {
    const evt: VerifiedBillingEvent = {
      id: row.provider_event_id,
      type: row.event_type,
      created: row.event_created_at,
      subscription_ref: row.subscription_ref,
      ...(row.checkout_session_ref !== null ? { checkout_session_ref: row.checkout_session_ref } : {}),
      ...(row.object_ref !== undefined && row.object_ref !== null ? { object_ref: row.object_ref } : {}),
    };
    let result: WebhookResult;
    try {
      result = await this.lifecycle.handleEvent(evt, assertProductKey(row.product_key), at);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.prisma.billingWebhookInbox.updateMany({
        where: { id: row.id, status: 'PROCESSING', attempts: row.attempts },
        data: { status: 'FAILED', last_error: message, lease_until: null, next_attempt_at: new Date(at.getTime() + billingCommandBackoffMs(row.attempts)), updated_at: at },
      });
      this.log.warn(`billing webhook ${row.provider_event_id} (${row.event_type}) FAILED (attempt ${row.attempts}): ${message}`);
      throw err;
    }
    await this.prisma.billingWebhookInbox.updateMany({
      where: { id: row.id, status: 'PROCESSING', attempts: row.attempts },
      data: {
        status: 'PROCESSED',
        outcome: result.outcome,
        detail: ('detail' in result ? result.detail : undefined)?.slice(0, 500) ?? null,
        lease_until: null,
        next_attempt_at: null,
        processed_at: at,
        updated_at: at,
      },
    });
    return result;
  }

  /** Operator read (GET /platform/commercial/billing-webhook-inbox): newest first, keyset cursor. */
  async list(q: { status?: BillingWebhookInboxStatus; limit?: number; cursor?: string }): Promise<{ events: BillingWebhookInboxRow[]; next_cursor: string | null }> {
    if (q.status !== undefined && !(BILLING_WEBHOOK_INBOX_STATUSES as readonly string[]).includes(q.status)) throw new BillingWebhookInboxQueryError('unknown status');
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const filter = JSON.stringify([q.status ?? null]);
    let after: { at: Date; id: string } | null = null;
    if (q.cursor !== undefined) {
      after = decodeInboxCursor(q.cursor, filter);
      if (after === null) throw new BillingWebhookInboxQueryError('malformed cursor, or cursor filters do not match the current query');
    }
    const rows = (await this.prisma.billingWebhookInbox.findMany({
      where: {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(after !== null ? { OR: [{ received_at: { lt: after.at } }, { received_at: after.at, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as BillingWebhookInboxRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { events: page, next_cursor: rows.length > limit && last !== undefined ? encodeInboxCursor(last.received_at, last.id, filter) : null };
  }
}
