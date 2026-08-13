// Hand-mirrored from libs/selection/src/lib/{selection-state,
// selection-event}.ts and libs/selection/src/lib/dto/*. Source-annotated.
// R7 hand-mirrors instead of importing @aramo/selection (a forbidden
// domain edge; a BE endpoint is a backend change R7 halts on).
//
// The legal-transition matrix is mirrored in ./legal-transitions.ts and
// guarded by ./legal-transitions-drift.spec.ts — it reads the BE source's
// inline `const ALLOWED:` map (Amendment v1.1 / RULING 2: the selection
// matrix is an inline const inside canTransition(), NOT a top-level
// export like pipeline's LEGAL_TRANSITIONS).

// SelectionState — 11 states, Loops 1-5 (mirror of
// SELECTION_STATE_VALUES). Terminals: maybe / passed / not_interested /
// submitted.
export const SELECTION_STATE_VALUES = [
  'surfaced',
  'evaluated',
  'engaged',
  'maybe',
  'passed',
  'awaiting_response',
  'responded',
  'in_conversation',
  'not_interested',
  'ready_for_submittal',
  'submitted',
] as const;
export type SelectionState = (typeof SELECTION_STATE_VALUES)[number];

// Display labels (the recruiter-facing nouns). Snake_case identifiers in
// the state machine; human form in the UI.
export const SELECTION_STATE_LABELS: Record<SelectionState, string> = {
  surfaced: 'Surfaced',
  evaluated: 'Evaluated',
  engaged: 'Engaged',
  maybe: 'Maybe',
  passed: 'Passed',
  awaiting_response: 'Awaiting response',
  responded: 'Responded',
  in_conversation: 'In conversation',
  not_interested: 'Not interested',
  ready_for_submittal: 'Ready for submittal',
  submitted: 'Submitted',
};

// SelectionEventType — 5 types (mirror of SELECTION_EVENT_TYPE_VALUES,
// incl. outreach_drafted added by the Outreach Draft/Preview split).
export const SELECTION_EVENT_TYPE_VALUES = [
  'state_transition',
  'outreach_drafted',
  'outreach_sent',
  'response_received',
  'conversation_started',
] as const;
export type SelectionEventType =
  (typeof SELECTION_EVENT_TYPE_VALUES)[number];

export const SELECTION_EVENT_TYPE_LABELS: Record<
  SelectionEventType,
  string
> = {
  state_transition: 'State change',
  outreach_drafted: 'Outreach drafted',
  outreach_sent: 'Outreach sent',
  response_received: 'Response received',
  conversation_started: 'Conversation started',
};

// SelectionView — hand-mirror of TalentSelectionView. IDs only (no
// talent_name / requisition_title) → the §7 N+1: names are resolved via
// getTalent + getRequisition at the consumption sites. created_at is an
// ISO-8601 string at the HTTP boundary (Postgres timestamptz → Prisma
// Date → JSON.stringify ISO string).
export interface SelectionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly examination_id: string | null;
  readonly state: SelectionState;
  readonly created_at: string;
}

export interface SelectionListResponse {
  readonly items: readonly SelectionView[];
}

// SelectionEventView — hand-mirror of TalentSelectionEventView.
// event_payload is `unknown` at the boundary (mirrors the BE view); the
// EventLog narrows on event_type at render via the per-type payload
// shapes below.
export interface SelectionEventView {
  readonly id: string;
  readonly tenant_id: string;
  readonly selection_id: string;
  readonly event_type: SelectionEventType;
  readonly event_payload: unknown;
  readonly created_at: string;
}

export interface SelectionEventsResponse {
  readonly events: readonly SelectionEventView[];
}

// ---- per-event-type payload shapes (narrowed at render) ----------------

// state_transition — { from_state, to_state }. from_state is null on the
// initial 'surfaced' creation event (selection.repository.ts:570).
export interface StateTransitionPayload {
  readonly from_state: SelectionState | null;
  readonly to_state: SelectionState;
}

// outreach_drafted — the PENDING AI draft (the human-in-the-loop preview
// substrate). The outreach text is persisted here per the ADR-0015
// addendum (selection event log carries outreach text; ai-draft stays
// hash-only).
export interface OutreachDraftedPayload {
  readonly draft_text: string;
  readonly ai_draft_audit_record_id: string;
  readonly model_used: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly duration_ms: number;
  readonly prompt: string;
  readonly max_tokens: number;
  readonly system_message?: string;
  readonly recipient_handle?: string;
}

// outreach_sent — the FINAL sent text + the source_draft_event_id
// back-reference (the editable trail: drafted text and sent text both
// persist and may differ).
export interface OutreachSentPayload {
  readonly ai_draft_audit_record_id: string;
  readonly model_used: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly duration_ms: number;
  readonly delivered_at: string;
  readonly delivery_channel: 'email';
  readonly delivery_id: string;
  readonly final_text: string;
  readonly source_draft_event_id: string;
}

export interface ResponseReceivedPayload {
  readonly response_received_at: string;
  readonly recorded_by_user_id: string;
  readonly outreach_event_ref_id: string;
}

export interface ConversationStartedPayload {
  readonly conversation_started_at: string;
  readonly recorded_by_user_id: string;
}

// ---- request bodies ----------------------------------------------------

// POST /v1/selections/:id/transitions — { to_state, event_id }. The
// event_id is a client-supplied UUID (the BE @IsUUID-validates it; create
// generates it server-side, but transitions carry it in the body). Plus
// the Idempotency-Key header (see ./selection-api.ts).
export interface TransitionSelectionRequest {
  readonly to_state: SelectionState;
  readonly event_id: string;
}

// POST /v1/selections/:id/response — the outreach_event_ref_id references
// a prior outreach_sent event (RULING 3 — a response answers a SENT
// outreach, not a draft). recorded_by_user_id is server-derived (NOT in
// the FE body).
export interface RecordResponseRequest {
  readonly response_received_at: string;
  readonly outreach_event_ref_id: string;
}

// POST /v1/selections/:id/conversation — single field.
export interface RecordConversationRequest {
  readonly conversation_started_at: string;
}

// ---- response envelopes ------------------------------------------------

export interface TransitionSelectionResponse {
  readonly selection: SelectionView;
}

export interface RecordResponseResponse {
  readonly selection: SelectionView;
  readonly response_event: SelectionEventView;
}

export interface RecordConversationResponse {
  readonly selection: SelectionView;
  readonly conversation_event: SelectionEventView;
}

// ---- outreach composer (PR-2) — draft → preview → send -----------------
// Hand-mirrored from libs/selection/src/lib/dto/outreach-draft-request.dto.ts,
// outreach-draft-response.dto.ts, outreach-send-request.dto.ts, and
// outreach-send-response.dto.ts. The composer is a pure FE consumer of the
// PR#218 draft/send split (the atomic outreach path was removed — preview-
// before-send is the only path).

// POST /v1/selections/:id/outreach/draft — the GENERATION half. The prompt
// runs the LLM; max_tokens/system_message are optional provider passthroughs;
// recipient_handle is an optional opaque correlation handle. Carried with an
// Idempotency-Key header RE-MINTED per generation attempt (a changed prompt
// is a new operation — a re-draft must actually re-run, never replay).
export interface OutreachDraftRequest {
  readonly prompt: string;
  readonly max_tokens?: number;
  readonly system_message?: string;
  readonly recipient_handle?: string;
}

// consent_warning — OPTIONAL, NON-blocking soft pre-check returned at draft
// time. Informational only: drafting still succeeded. The BINDING consent
// gate (403 CONSENT_NOT_GRANTED_AT_SEND) fires at SEND, not here.
export interface OutreachDraftConsentWarning {
  readonly reason_code?: string;
  readonly display_message?: string;
}

export interface OutreachDraftResponse {
  readonly draft_event_id: string;
  readonly draft_text: string;
  readonly ai_draft_audit_record_id: string;
  readonly consent_warning?: OutreachDraftConsentWarning;
}

// POST /v1/selections/:id/outreach/send — the DELIVERY half. Takes the
// source draft_event_id + the recruiter-approved final_text (which may differ
// from draft_text — the editable trail). Carried with an Idempotency-Key
// header KEYED ON draft_event_id (stable across send retries → dedupes,
// never double-delivers).
export interface OutreachSendRequest {
  readonly draft_event_id: string;
  readonly final_text: string;
  readonly recipient_handle?: string;
}

export interface OutreachSendResponse {
  readonly selection: SelectionView;
  readonly outreach_event: SelectionEventView;
  readonly delivery_id: string;
}
