import { apiClient } from '@aramo/fe-foundation';

// Recruiting-Journey §7/§15 — the canonical "Record Talent response" command. The FE
// NEVER sets Pipeline stage: this records durable recruiter-attested response evidence
// and the backend advances the milestone through canonical evidence authority. The
// Talent/Requisition are resolved server-side FROM the pipeline (never sent here).

// The FE channel tiles (Phone / Email / SMS / Other). `phone` maps to the backend
// `voice` channel; the rest pass through unchanged.
export type TalentResponseChannelChoice = 'phone' | 'email' | 'sms' | 'other';

export interface RecordTalentResponseRequest {
  readonly pipeline_id: string;
  readonly channel: TalentResponseChannelChoice;
  // ISO-8601 instant the Talent responded (recruiter-supplied; server-validated:
  // not future, not before the first grounded outbound contact).
  readonly occurred_at: string;
  readonly note?: string;
}

export interface RecordTalentResponseResult {
  readonly interaction_id: string;
  readonly deduped: boolean;
  readonly pipeline_stage: string;
  readonly pipeline_version: number;
}

const CHANNEL_TO_BACKEND: Record<TalentResponseChannelChoice, string> = {
  phone: 'voice',
  email: 'email',
  sms: 'sms',
  other: 'other',
};

// POST /v1/communications/talent-responses (pipeline:change-status). A required
// Idempotency-Key makes a retried recorder a no-op (one evidence record, one effective
// milestone) while genuinely separate responses carry distinct keys. The caller passes
// a stable key for the lifetime of one submit attempt (incl. retries) so a "Try again"
// after a transient failure dedupes rather than double-records.
export async function recordTalentResponse(
  req: RecordTalentResponseRequest,
  idempotencyKey: string,
): Promise<RecordTalentResponseResult> {
  return apiClient.post<RecordTalentResponseResult>(
    `/v1/communications/talent-responses`,
    {
      pipeline_id: req.pipeline_id,
      channel: CHANNEL_TO_BACKEND[req.channel],
      occurred_at: req.occurred_at,
      ...(req.note === undefined ? {} : { note: req.note }),
    },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}
