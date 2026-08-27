import { Injectable } from '@nestjs/common';

import type { LifecycleSourceAdapter } from './lifecycle-source-adapter.port.js';

// CB-D2-A1 (ADR-0030) — the provider-neutral lifecycle-source adapter registry.
// Mirrors ConnectorAdapterRegistry (register/resolve by normalized provider_key),
// but keyed to the SPLIT LifecycleSourceAdapter port (observations/events), NOT
// the CREATE-only ConnectorAdapter. Connector-B registers concrete provider
// lifecycle sources under provider-specific authority; A1 registers only a fake.
@Injectable()
export class LifecycleSourceAdapterRegistry {
  private readonly adapters = new Map<string, LifecycleSourceAdapter>();

  register(adapter: LifecycleSourceAdapter): void {
    this.adapters.set(adapter.providerKey, adapter);
  }

  /** Resolve a lifecycle source for a provider key, or null when none is registered. */
  resolve(providerKey: string): LifecycleSourceAdapter | null {
    return this.adapters.get(providerKey) ?? null;
  }

  has(providerKey: string): boolean {
    return this.adapters.has(providerKey);
  }
}
