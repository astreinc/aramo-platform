// M5 PR-5 §4.5 — DraftProvider port. Adapters implement this interface
// (AnthropicProvider lands at §4.6). Per ADR-0015: the substrate is
// LLM-vendor-agnostic at the port layer; the adapter is the only
// vendor-specific surface.

import type { ProviderGenerateInput } from '../dto/provider-generate-input.dto.js';
import type { ProviderGenerateResult } from '../dto/provider-generate-result.dto.js';

export interface DraftProvider {
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}
