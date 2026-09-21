import { Injectable } from '@nestjs/common';
import { TenantSettingService } from '@aramo/settings';
import type { ActiveProviderResolver, LlmProvider } from '@aramo/ai-draft';

// TENANT-LLM-2 — the settings-backed implementation of ai-draft's
// ActiveProviderResolver port. Reads the tenant's `llm.active_provider`
// KnownSetting (default 'anthropic') by the OWNED tenant_id. This is the bridge
// that lets ai-draft route by the tenant's selection WITHOUT ai-draft importing
// @aramo/settings (the port keeps the lib a leaf; this impl lives app-side).
//
// SettingValueOf<'llm.active_provider'> is the wired 'anthropic'|'openai' union,
// structurally identical to ai-draft's LlmProvider — the setting validator (at
// the write path) is what guarantees the stored value is always wired.
@Injectable()
export class SettingsActiveProviderResolver implements ActiveProviderResolver {
  constructor(private readonly settings: TenantSettingService) {}

  async resolveActiveProvider(tenantId: string): Promise<LlmProvider> {
    const provider = await this.settings.get(tenantId, 'llm.active_provider');
    return provider;
  }
}
