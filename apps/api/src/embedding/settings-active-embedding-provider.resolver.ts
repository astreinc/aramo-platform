import { Injectable } from '@nestjs/common';
import { TenantSettingService } from '@aramo/settings';
import type { ActiveEmbeddingProviderResolver, EmbeddingProvider } from '@aramo/ai-draft';

// Enterprise Search GS-2 P2 — the settings-backed implementation of ai-draft's
// ActiveEmbeddingProviderResolver port. Reads the tenant's `embedding.active_provider`
// KnownSetting (default 'openai') by the OWNED tenant_id. This is DELIBERATELY SEPARATE from
// SettingsActiveProviderResolver (chat): embedding selection reads `embedding.active_provider`
// and NEVER `llm.active_provider`. Keeps ai-draft a settings leaf (it depends on the port, not on
// @aramo/settings).
//
// SettingValueOf<'embedding.active_provider'> is the wired 'openai' union, structurally identical
// to ai-draft's EmbeddingProvider — the setting validator (at the write path) guarantees the
// stored value is always wired.
@Injectable()
export class SettingsActiveEmbeddingProviderResolver implements ActiveEmbeddingProviderResolver {
  constructor(private readonly settings: TenantSettingService) {}

  async resolveActiveEmbeddingProvider(tenantId: string): Promise<EmbeddingProvider> {
    return this.settings.get(tenantId, 'embedding.active_provider');
  }
}
