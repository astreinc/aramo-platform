import type {
  AramoEventEnvelope,
  OutboxPublishResult,
  OutboxPublisherPort,
} from '@aramo/events';

// ADR-0033 — the test fake for OutboxPublisherPort. Lets a test specify EXACT
// per-event outcomes (including mixed success/failure in one batch), so partial
// success, full outage, replay, and lease-reclaim are provable without AWS.
//
// Default: every event succeeds. failEventIds forces specific event_ids to the
// failed bucket; failAll forces a total-outage batch. Records published calls so
// a test can assert no event was published more than once effectively.
export class FakeOutboxPublisher implements OutboxPublisherPort {
  private failEventIds = new Set<string>();
  private failAll = false;
  // Every event_id ever reported published, in call order (replay inspection).
  public readonly publishedLog: string[] = [];
  public publishCalls = 0;

  failEvents(ids: readonly string[]): this {
    for (const id of ids) {
      this.failEventIds.add(id);
    }
    return this;
  }

  failEverything(on = true): this {
    this.failAll = on;
    return this;
  }

  recover(): this {
    this.failEventIds.clear();
    this.failAll = false;
    return this;
  }

  async publish(
    envelopes: readonly AramoEventEnvelope[],
  ): Promise<OutboxPublishResult> {
    this.publishCalls += 1;
    const published: string[] = [];
    const failed: string[] = [];
    for (const env of envelopes) {
      if (this.failAll || this.failEventIds.has(env.event_id)) {
        failed.push(env.event_id);
      } else {
        published.push(env.event_id);
        this.publishedLog.push(env.event_id);
      }
    }
    return { published_event_ids: published, failed_event_ids: failed };
  }
}
