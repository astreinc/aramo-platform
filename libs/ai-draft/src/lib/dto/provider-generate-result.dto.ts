// M5 PR-5 §4.11 — DraftProvider.generate result.

export interface ProviderGenerateResult {
  completion: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  provider_request_id: string;
}
