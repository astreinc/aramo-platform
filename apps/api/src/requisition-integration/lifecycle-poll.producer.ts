import { Injectable, Logger } from '@nestjs/common';
import {
  IntegrationConnectionRepository,
  LifecycleSourceAdapterRegistry,
  type LifecycleFetchResult,
} from '@aramo/integration';

import { LifecycleIngressService } from './lifecycle-ingress.service.js';

// CB-D2-A1 (ADR-0030 seam #7, R-PRODUCER) — the provider-neutral lifecycle-poll
// producer. It sweeps ACTIVE lifecycle-capable connections, resolves a
// LifecycleSourceAdapter per provider_key (skipping any with no registered
// source — A1 registers only a fake), fetches the delivery + changes, RAW-PERSISTS
// then INGRESSES each change through the L1-D1 seam, and advances the connection
// cursor ONLY after every change is durably processed (persist-then-process,
// R-DURABILITY). A crash after fetch replays locally — the ledger dedups.
//
// Scheduling (the BullMQ SCHEDULES repeat tick) is Redis-gated in the processor;
// this producer is a plain service so the integration proofs drive pollConnection
// directly with the fake source (no Redis).
@Injectable()
export class LifecyclePollProducer {
  private readonly logger = new Logger(LifecyclePollProducer.name);

  constructor(
    private readonly connections: IntegrationConnectionRepository,
    private readonly sources: LifecycleSourceAdapterRegistry,
    private readonly ingress: LifecycleIngressService,
  ) {}

  /** Sweep every ACTIVE connection that has a registered lifecycle source. */
  async pollAllActive(): Promise<void> {
    const active = await this.connections.listActiveForLifecyclePoll();
    for (const conn of active) {
      if (!this.sources.has(conn.provider_key)) continue;
      try {
        await this.pollConnection(conn);
      } catch (err) {
        // A per-connection failure degrades that connection and is isolated — the
        // sweep continues. The cursor is NOT advanced (persist-then-process), so
        // the next tick re-fetches from the same watermark; the ledger dedups.
        const summary = err instanceof Error ? err.message : 'lifecycle poll error';
        await this.connections.recordError(
          conn.tenant_id,
          conn.id,
          'LIFECYCLE_POLL_FAILED',
          summary,
        );
        this.logger.warn(`lifecycle poll failed for connection ${conn.id}: ${summary}`);
      }
    }
  }

  /**
   * Poll ONE connection: fetch → raw-persist+ingress each change → advance cursor
   * only after all changes are durably processed. Returns the fetch result for
   * test assertions.
   */
  async pollConnection(conn: {
    id: string;
    tenant_id: string;
    provider_key: string;
    cursor: string | null;
  }): Promise<LifecycleFetchResult | null> {
    const adapter = this.sources.resolve(conn.provider_key);
    if (adapter === null) return null;

    const result = await adapter.fetchLifecycleChanges({
      tenant_id: conn.tenant_id,
      connection_id: conn.id,
      provider_key: conn.provider_key,
      cursor: conn.cursor,
      // A1 is provider-neutral: credential resolution is a real-adapter concern
      // (later slice). The fake source ignores it.
      credential: null,
    });

    for (const change of result.changes) {
      await this.ingress.ingest({
        tenant_id: conn.tenant_id,
        connection_id: conn.id,
        provider_key: conn.provider_key,
        delivery_id: result.delivery.delivery_id,
        change,
      });
    }

    // Advance the watermark ONLY after every change is durably processed.
    if (result.next_cursor !== undefined) {
      await this.connections.advanceCursor(conn.tenant_id, conn.id, result.next_cursor ?? null);
    }
    return result;
  }
}
