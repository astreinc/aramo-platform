import type {
  LifecycleFetchContext,
  LifecycleFetchResult,
  LifecycleSourceAdapter,
} from '@aramo/integration';

// CB-D2-A1 (ADR-0030) — a deterministic FAKE lifecycle source for the ingress
// proofs. It is NOT a provider adapter runtime (no Fieldglass/Workday/iLabor
// parsing) — it just returns pre-scripted LifecycleFetchResults so the neutral
// ingress + poll producer can be proven with synthetic observations/events. The
// context (cursor/credential) is recorded for watermark assertions but ignored for
// content.
export class FakeLifecycleSource implements LifecycleSourceAdapter {
  readonly providerKey: string;
  private readonly script: LifecycleFetchResult[];
  readonly contexts: LifecycleFetchContext[] = [];

  constructor(providerKey: string, script: LifecycleFetchResult[]) {
    this.providerKey = providerKey;
    this.script = [...script];
  }

  fetchLifecycleChanges(ctx: LifecycleFetchContext): Promise<LifecycleFetchResult> {
    this.contexts.push(ctx);
    const next = this.script.shift();
    if (next === undefined) {
      return Promise.resolve({
        delivery: { delivery_id: `empty-${this.contexts.length}`, received_at: new Date().toISOString() },
        changes: [],
      });
    }
    return Promise.resolve(next);
  }
}
