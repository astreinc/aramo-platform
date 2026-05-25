// M5 PR-5 §4.11 — AiDraftService.generateDraft input.

export interface GenerateDraftInput {
  tenant_id: string;
  prompt: string;
  max_tokens: number;
  model?: string;
  system_message?: string;
  requestId?: string;
}
