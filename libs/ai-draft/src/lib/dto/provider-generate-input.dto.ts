// M5 PR-5 §4.11 — DraftProvider.generate input.

export interface ProviderGenerateInput {
  model: string;
  prompt: string;
  max_tokens: number;
  system_message?: string;
}
