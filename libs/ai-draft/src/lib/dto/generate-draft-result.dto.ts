// M5 PR-5 §4.11 — AiDraftService.generateDraft result.

export interface GenerateDraftResult {
  completion: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  audit_record_id: string;
}
