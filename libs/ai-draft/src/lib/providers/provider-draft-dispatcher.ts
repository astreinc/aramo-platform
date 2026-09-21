import { Inject, Injectable, Optional } from '@nestjs/common';

import type { ProviderGenerateInput } from '../dto/provider-generate-input.dto.js';
import type { ProviderGenerateResult } from '../dto/provider-generate-result.dto.js';

import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import type { DraftProvider } from './draft-provider.interface.js';
import {
  ACTIVE_PROVIDER_RESOLVER,
  type ActiveProviderResolver,
} from './active-provider-resolver.js';
import { resolveProviderModel, type LlmProvider } from './llm-provider.js';

// TENANT-LLM-2 §2.1 — the tenant-aware DraftProvider dispatcher. Bound to
// DRAFT_PROVIDER_TOKEN (replacing the static Anthropic binding), so the three
// existing ai-draft consumers stay UNCHANGED: both ports already carry the
// owned tenant_id. At call time it resolves the tenant's active provider, picks
// the matching adapter, and pins the provider-appropriate model — with NO
// cross-provider/cross-tenant/platform fallback (isolation is the adapter's key
// resolution; routing is here).
//
// The ActiveProviderResolver is @Optional: when unbound (ai-draft used
// standalone / in isolated tests) it defaults to 'anthropic' — the exact
// pre-TENANT-LLM-2 behaviour. apps/api binds the settings-backed resolver via a
// @Global module so this dispatcher routes by the tenant's llm.active_provider.
@Injectable()
export class ProviderDraftDispatcher implements DraftProvider {
  constructor(
    private readonly anthropic: AnthropicProvider,
    private readonly openai: OpenAiProvider,
    @Optional()
    @Inject(ACTIVE_PROVIDER_RESOLVER)
    private readonly resolver?: ActiveProviderResolver,
  ) {}

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const provider = await this.resolveProvider(input.tenant_id);
    const model = resolveProviderModel(provider, input.model);
    const adapter: DraftProvider = provider === 'openai' ? this.openai : this.anthropic;
    return adapter.generate({ ...input, model });
  }

  private async resolveProvider(tenantId: string): Promise<LlmProvider> {
    if (this.resolver === undefined) return 'anthropic';
    return this.resolver.resolveActiveProvider(tenantId);
  }
}
