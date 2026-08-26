import { Injectable } from '@nestjs/common';

import type { VoiceProvider } from './voice-provider.port.js';

// COMM-V1 — the VoiceProviderRegistry (COMM-B1, R-COMM-PROVIDER-PORT). Mirrors
// the integration ConnectorAdapterRegistry PATTERN: keyed by a normalized
// provider_key string (never a frozen vendor enum). Ships EMPTY in B1 — concrete
// vendor adapters register in a later slice.
@Injectable()
export class VoiceProviderRegistry {
  private readonly providers = new Map<string, VoiceProvider>();

  register(provider: VoiceProvider): void {
    this.providers.set(provider.providerKey(), provider);
  }

  resolve(providerKey: string): VoiceProvider | null {
    return this.providers.get(providerKey) ?? null;
  }

  has(providerKey: string): boolean {
    return this.providers.has(providerKey);
  }

  /** All registered providers (registration order). Empty until an adapter registers. */
  list(): VoiceProvider[] {
    return [...this.providers.values()];
  }
}
