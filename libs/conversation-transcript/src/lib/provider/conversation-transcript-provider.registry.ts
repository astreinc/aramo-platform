// CI-B3 — provider registry (mirrors the communications VoiceProviderRegistry
// PATTERN). Ships EMPTY in B3: no real provider adapter is registered (the
// provider adapter seams CI-B5Z / CI-B5M land later). Keyed by provider.providerKey().

import { Injectable } from '@nestjs/common';

import type { ConversationTranscriptProvider } from './conversation-transcript-provider.port.js';

@Injectable()
export class ConversationTranscriptProviderRegistry {
  private readonly byKey = new Map<string, ConversationTranscriptProvider>();

  register(provider: ConversationTranscriptProvider): void {
    this.byKey.set(provider.providerKey(), provider);
  }

  get(providerKey: string): ConversationTranscriptProvider | undefined {
    return this.byKey.get(providerKey);
  }

  has(providerKey: string): boolean {
    return this.byKey.has(providerKey);
  }
}
