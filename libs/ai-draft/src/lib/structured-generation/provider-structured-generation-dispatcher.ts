import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  ACTIVE_PROVIDER_RESOLVER,
  type ActiveProviderResolver,
} from '../providers/active-provider-resolver.js';
import { resolveProviderModel, type LlmProvider } from '../providers/llm-provider.js';

import { AnthropicStructuredGenerationService } from './anthropic-structured-generation.service.js';
import { OpenAiStructuredGenerationService } from './openai-structured-generation.service.js';
import {
  type StructuredGenerationOutcome,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
} from './structured-generation.types.js';

// TENANT-LLM-2 §2.1 — the tenant-aware StructuredGenerationProvider dispatcher.
// Bound to STRUCTURED_GENERATION_PROVIDER (replacing the static Anthropic
// binding). Resolves the tenant's active provider per call, pins the
// provider-appropriate model, and delegates to the matching adapter — which maps
// to the SAME provider-neutral StructuredGenerationOutcome (grounding parity).
// No cross-provider/cross-tenant/platform fallback.
@Injectable()
export class ProviderStructuredGenerationDispatcher implements StructuredGenerationProvider {
  constructor(
    private readonly anthropic: AnthropicStructuredGenerationService,
    private readonly openai: OpenAiStructuredGenerationService,
    @Optional()
    @Inject(ACTIVE_PROVIDER_RESOLVER)
    private readonly resolver?: ActiveProviderResolver,
  ) {}

  // Tenant-agnostic registration/telemetry key (this dispatcher is a singleton;
  // per-tenant routing happens in generateStructured, and the actual provider is
  // reflected in the outcome's transport.model_used). Kept as 'anthropic' — the
  // pre-TENANT-LLM-2 key — so the (dark) CI provider-registry keying is stable.
  providerKey(): string {
    return 'anthropic';
  }

  async generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationOutcome> {
    const provider = await this.resolveProvider(request.tenant_id);
    const model = resolveProviderModel(provider, request.model);
    const adapter: StructuredGenerationProvider =
      provider === 'openai' ? this.openai : this.anthropic;
    return adapter.generateStructured({ ...request, model });
  }

  private async resolveProvider(tenantId: string): Promise<LlmProvider> {
    if (this.resolver === undefined) return 'anthropic';
    return this.resolver.resolveActiveProvider(tenantId);
  }
}
