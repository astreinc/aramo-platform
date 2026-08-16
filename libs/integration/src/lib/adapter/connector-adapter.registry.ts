import { Injectable } from '@nestjs/common';

import type { ConnectorAdapter } from './connector-adapter.port.js';

// T8-CONNECTOR-A — extensible provider adapter registry (directive §12). Keyed by
// the normalized provider_key string; NEVER a frozen vendor enum. Connector-B
// registers concrete provider adapters under provider-specific authority.

@Injectable()
export class ConnectorAdapterRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): void {
    this.adapters.set(adapter.providerKey, adapter);
  }

  /** Resolve an adapter for a provider key, or null when none is registered. */
  resolve(providerKey: string): ConnectorAdapter | null {
    return this.adapters.get(providerKey) ?? null;
  }

  has(providerKey: string): boolean {
    return this.adapters.has(providerKey);
  }
}
