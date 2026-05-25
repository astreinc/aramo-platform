// M5 PR-5 §4.11 — DB projection for AiDraftEvent rows.

import type { AiDraftEventType } from './event-payloads.js';

export interface AiDraftEventView {
  id: string;
  tenant_id: string;
  event_type: AiDraftEventType;
  event_payload: unknown;
  created_at: Date;
}
