import type { AramoLogger } from '@aramo/common';
import {
  buildEventEnvelope,
  type AramoEventEnvelope,
  type EnvelopeDefaults,
  type LeaseSafeOutboxRepository,
  type LeasedOutboxRow,
  type OutboxDrainOutcome,
  type OutboxPublisherPort,
} from '@aramo/events';

// ADR-0033 Decision 1 — the transport-agnostic lease-safe drain orchestration.
//
// This service does NOT know EventBridge (or SQS/SNS/Lambda) exists. It depends
// only on the LeaseSafeOutboxRepository (durable claim/lease), buildEventEnvelope
// (pure mapping), and the OutboxPublisherPort (whatever adapter is bound by DI).
// Horizontally scalable on the PUBLISHER side (SKIP LOCKED + DB-time lease);
// delivery to consumers remains AT-LEAST-ONCE — lease-safe publishing is NOT
// exactly-once delivery. Duplicate external delivery is harmless because the
// event_id (outbox row id) is the consumer's idempotency anchor.
//
// Per tick:
//   claim N safely → map to canonical envelopes → quarantine permanently-
//   unmappable rows → publish through the port → mark ONLY transport-confirmed
//   ids published → release transient failures (immediately reclaimable) →
//   quarantine over-budget failures (deterministic from persisted attempts).

export interface LeaseSafeOutboxDrainConfig {
  readonly limit: number;
  readonly lease_seconds: number;
  readonly max_attempts: number;
}

export class LeaseSafeOutboxDrainService {
  constructor(
    private readonly repo: LeaseSafeOutboxRepository,
    private readonly publisher: OutboxPublisherPort,
    private readonly defaults: EnvelopeDefaults,
    private readonly config: LeaseSafeOutboxDrainConfig,
    private readonly logger: AramoLogger,
    // Which port implementation is bound — logged for operability, never used
    // for control flow (transport selection is DI, not conditional code).
    private readonly adapterName: string,
  ) {}

  async drainOnce(): Promise<OutboxDrainOutcome> {
    const rows = await this.repo.claimOutboxBatch({
      limit: this.config.limit,
      lease_seconds: this.config.lease_seconds,
      max_attempts: this.config.max_attempts,
    });
    if (rows.length === 0) {
      return { claimed: 0, published: 0, failed: 0, quarantined: 0 };
    }

    // 1. Map rows → envelopes. An UNMAPPABLE row (malformed/invalid durable row)
    //    is a DISTINCT operational condition from a transport failure, and is
    //    non-transient → quarantine immediately (never retried, stays visible).
    const envelopes: AramoEventEnvelope[] = [];
    const byId = new Map<string, LeasedOutboxRow>();
    const unmappable: string[] = [];
    for (const row of rows) {
      byId.set(row.id, row);
      try {
        envelopes.push(buildEventEnvelope(row, this.defaults));
      } catch (err) {
        unmappable.push(row.id);
        this.logger.warn({
          event: 'outbox_row_unmappable',
          adapter: this.adapterName,
          event_id: row.id,
          tenant_id: row.tenant_id,
          event_type: row.event_type,
          correlation_id: row.correlation_id,
          attempt: row.publish_attempts,
          failure_category: 'mapping',
          outcome: 'quarantined',
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    let quarantined = 0;
    if (unmappable.length > 0) {
      quarantined += await this.repo.quarantineOutbox({
        event_ids: unmappable,
        reason: 'envelope_mapping_failed',
      });
    }
    if (envelopes.length === 0) {
      return { claimed: rows.length, published: 0, failed: 0, quarantined };
    }

    // 2. Publish through the port. The adapter maps PARTIAL success entry-by-
    //    entry; the whole batch is never marked published on a bare request OK.
    const result = await this.publisher.publish(envelopes);

    // 3. Confirmed → published_at (ONLY confirmed ids).
    const published = await this.repo.markOutboxPublished({
      event_ids: result.published_event_ids,
    });
    for (const id of result.published_event_ids) {
      const row = byId.get(id);
      this.logger.log({
        event: 'outbox_event_published',
        adapter: this.adapterName,
        event_id: id,
        tenant_id: row?.tenant_id,
        event_type: row?.event_type,
        correlation_id: row?.correlation_id,
        attempt: row?.publish_attempts,
        outcome: 'published',
      });
    }

    // 4. Transport failures: split retry-vs-quarantine DETERMINISTICALLY from the
    //    PERSISTED post-claim publish_attempts (returned by the claim), not
    //    process memory. Over budget → quarantine (visible); else release the
    //    lease → immediately reclaimable next tick.
    const overBudget: string[] = [];
    const retryable: string[] = [];
    for (const id of result.failed_event_ids) {
      const row = byId.get(id);
      const attempts = row?.publish_attempts ?? this.config.max_attempts;
      if (attempts >= this.config.max_attempts) {
        overBudget.push(id);
      } else {
        retryable.push(id);
      }
      this.logger.warn({
        event: 'outbox_publish_failed',
        adapter: this.adapterName,
        event_id: id,
        tenant_id: row?.tenant_id,
        event_type: row?.event_type,
        correlation_id: row?.correlation_id,
        attempt: attempts,
        failure_category: 'transport',
        outcome: attempts >= this.config.max_attempts ? 'quarantined' : 'retry',
      });
    }
    if (overBudget.length > 0) {
      quarantined += await this.repo.quarantineOutbox({
        event_ids: overBudget,
        reason: 'max_publish_attempts_exceeded',
      });
    }
    if (retryable.length > 0) {
      await this.repo.releaseOutboxLease({
        event_ids: retryable,
        last_error: 'transport_publish_failed',
      });
    }

    return {
      claimed: rows.length,
      published,
      failed: result.failed_event_ids.length,
      quarantined,
    };
  }
}
