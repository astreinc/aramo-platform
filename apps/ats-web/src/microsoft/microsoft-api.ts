// COMM-C2B — Microsoft 365 recruiter + admin client (ats-web). Provider-neutral
// at the surface; no token/secret ever crosses this boundary.

import { apiClient } from '@aramo/fe-foundation';

export type MicrosoftIdentityStatus = 'active' | 'unmapped' | 'disabled' | 'reauth_required';

export interface MicrosoftBindingStatus {
  readonly connection_id: string;
  readonly bound: boolean;
  readonly status: MicrosoftIdentityStatus;
  readonly needs_reauthorization: boolean;
}

export interface MicrosoftEmailSendResult {
  readonly interaction_id: string;
  readonly status: 'accepted';
  readonly talent_record_id: string;
  // COMM-RECRUITER-W1 (W1-A2) — null for a requisition-free General Talent Contact send.
  readonly requisition_id: string | null;
  readonly idempotent_replay: boolean;
}

export interface MicrosoftMeetingResult {
  readonly interaction_id: string;
  readonly join_url: string;
  readonly scheduled_start: string;
  readonly scheduled_end: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly idempotent_replay: boolean;
}

export type MicrosoftConfigurationState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'REQUIRES_ATTENTION';

export interface MicrosoftProviderStatus {
  // PART B — tenant provider CONFIGURATION state (distinct from recruiter auth).
  readonly configuration_state: MicrosoftConfigurationState;
  readonly connection_id: string | null;
  readonly provider_key: string;
  readonly capabilities: { readonly email: boolean; readonly meeting: boolean };
  readonly identities: Record<MicrosoftIdentityStatus, number>;
}

// PART B — tenant-admin establishment input. client_secret is write-only: it is
// sent once and never read back; omitting it on an update keeps the stored one.
export interface ConfigureMicrosoftInput {
  readonly client_id: string;
  readonly authority_tenant: string;
  readonly client_secret?: string;
}

// COMM-C4 — the send contract carries NO recipient. The backend resolves the
// authoritative Talent email server-side; the client never supplies an address.
export interface SendEmailInput {
  readonly talent_record_id: string;
  // COMM-RECRUITER-W1 (W1-A2) — OPTIONAL: a General Talent Contact send has no
  // requisition. Omitted → the backend writes the Talent SUBJECT association only.
  readonly requisition_id?: string;
  readonly pipeline_id?: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotency_key: string;
  // D-EMAIL-TPL-1 (ET-8) — DESCRIPTIVE provenance of the reviewed draft, relayed
  // from the draft response (server-origin). Not authoritative; the server records
  // it as metadata only. Omitted for legacy/other send paths → columns stay null.
  readonly template_key?: string;
  readonly template_id?: string;
}

export interface CreateMeetingInput {
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  readonly subject: string;
  readonly start_date_time: string;
  readonly end_date_time: string;
  readonly idempotency_key: string;
}

// COMM-C4 PR-2 — requisition-contact draft generation. The backend resolves the
// authoritative Talent + Requisition + recruiter/tenant context and hydrates the
// system-owned template. Read/generate only: NO side effects, NO idempotency key,
// and the recipient is server-owned (editable:false) — the composer shows it but
// never submits it on send.
export interface RequisitionContactDraftInput {
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  // COMM-EMAIL-TEMPLATE-GOVERNANCE-1 — no client template choice; the server
  // resolves the governed template (tenant override else code default).
}

export interface RequisitionContactDraft {
  readonly to: {
    readonly email: string;
    readonly display_name: string | null;
    readonly editable: false;
  };
  readonly subject: string;
  readonly body: string;
  readonly context: {
    readonly requisition_reference: string;
    readonly requisition_title: string;
    readonly template_id: string;
    readonly template_version: string;
    // ET-5 — the logical template key the draft was rendered from.
    readonly template_key: string;
  };
  readonly warnings?: readonly string[];
}

export async function getMicrosoftBindingStatus(): Promise<MicrosoftBindingStatus> {
  return apiClient.get<MicrosoftBindingStatus>('/v1/integrations/microsoft/me');
}

// A1 R4 — opt-in scheduling consent. Omitting `capability` keeps the baseline
// authorize (send-only + create-link-only scopes, unchanged). `'scheduling'` requests
// the incremental Calendars.ReadWrite consent for Outlook calendar scheduling.
export async function startMicrosoftAuthorize(
  capability?: 'scheduling',
): Promise<{ authorize_url: string }> {
  const qs = capability !== undefined ? `?capability=${encodeURIComponent(capability)}` : '';
  return apiClient.get<{ authorize_url: string }>(`/v1/integrations/microsoft/authorize/start${qs}`);
}

export async function sendMicrosoftEmail(input: SendEmailInput): Promise<MicrosoftEmailSendResult> {
  return apiClient.post<MicrosoftEmailSendResult>('/v1/integrations/microsoft/email', input);
}

export async function createMicrosoftMeeting(input: CreateMeetingInput): Promise<MicrosoftMeetingResult> {
  return apiClient.post<MicrosoftMeetingResult>('/v1/integrations/microsoft/meeting', input);
}

// ─── M365-SCHED-1 PR 1B — Outlook/Teams CALENDAR scheduling (COMM-C2B Amendment A1) ───
// A DISTINCT capability from the create-link-only `/meeting` above (G-2): this creates
// a real Outlook calendar event and SENDS invitations. The legacy link-only client
// (`createMicrosoftMeeting`) and its result type are preserved untouched.

// The backend's ScheduledMeetingView (apps/api/src/microsoft/microsoft-scheduling.service.ts).
// `status` is intentionally a plain string: the UI handles the known lifecycle
// {scheduled, rescheduled, cancelled} and treats any other value conservatively.
export interface ScheduledMeetingView {
  readonly interaction_id: string;
  readonly operation_id: string | null;
  readonly provider_event_id: string | null;
  readonly join_url: string | null;
  readonly status: string;
  readonly version: number;
  readonly scheduled_start: string | null;
  readonly scheduled_end: string | null;
  readonly idempotent_replay: boolean;
}

export interface ScheduleCalendarMeetingInput {
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  readonly connection_id?: string;
  readonly subject: string;
  readonly start_date_time: string; // ISO-8601
  readonly end_date_time: string; // ISO-8601
  readonly time_zone: string; // validated IANA zone
  readonly idempotency_key: string;
}

export interface RescheduleCalendarMeetingInput {
  readonly connection_id?: string;
  readonly expected_version: number; // CAS guard
  readonly start_date_time: string;
  readonly end_date_time: string;
  readonly time_zone: string;
}

export interface CancelCalendarMeetingInput {
  readonly connection_id?: string;
  readonly expected_version: number;
  readonly comment?: string;
}

export interface ListCalendarMeetingsQuery {
  readonly talent_record_id?: string;
  readonly requisition_id?: string;
  readonly from?: string;
  readonly to?: string;
}

const CALENDAR_BASE = '/v1/integrations/microsoft/calendar-meeting';

export async function scheduleCalendarMeeting(
  input: ScheduleCalendarMeetingInput,
): Promise<ScheduledMeetingView> {
  return apiClient.post<ScheduledMeetingView>(CALENDAR_BASE, input);
}

export async function getCalendarMeeting(interactionId: string): Promise<ScheduledMeetingView> {
  return apiClient.get<ScheduledMeetingView>(`${CALENDAR_BASE}/${encodeURIComponent(interactionId)}`);
}

export async function listCalendarMeetings(
  query: ListCalendarMeetingsQuery = {},
): Promise<{ meetings: readonly ScheduledMeetingView[] }> {
  const params = new URLSearchParams();
  if (query.talent_record_id !== undefined) params.set('talent_record_id', query.talent_record_id);
  if (query.requisition_id !== undefined) params.set('requisition_id', query.requisition_id);
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  const qs = params.toString();
  return apiClient.get<{ meetings: readonly ScheduledMeetingView[] }>(
    `/v1/integrations/microsoft/calendar-meetings${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

export async function rescheduleCalendarMeeting(
  interactionId: string,
  input: RescheduleCalendarMeetingInput,
): Promise<ScheduledMeetingView> {
  return apiClient.patch<ScheduledMeetingView>(
    `${CALENDAR_BASE}/${encodeURIComponent(interactionId)}`,
    input,
  );
}

export async function cancelCalendarMeeting(
  interactionId: string,
  input: CancelCalendarMeetingInput,
): Promise<ScheduledMeetingView> {
  return apiClient.post<ScheduledMeetingView>(
    `${CALENDAR_BASE}/${encodeURIComponent(interactionId)}/cancel`,
    input,
  );
}

export async function generateRequisitionContactDraft(
  input: RequisitionContactDraftInput,
): Promise<RequisitionContactDraft> {
  return apiClient.post<RequisitionContactDraft>(
    '/v1/communications/email-drafts/requisition-contact',
    input,
  );
}

// COMM-RECRUITER-W1 (W1-A2) — General Talent Contact draft (Talent-only, no
// requisition). The backend resolves the governed template (tenant override else
// the gender-neutral code default) and the authoritative recipient. Read/generate
// only; recipient server-owned (editable:false).
export interface GeneralTalentContactDraftInput {
  readonly talent_record_id: string;
}

export interface GeneralTalentContactDraft {
  readonly to: {
    readonly email: string;
    readonly display_name: string | null;
    readonly editable: false;
  };
  readonly subject: string;
  readonly body: string;
  readonly context: {
    readonly template_id: string;
    readonly template_version: string;
    readonly template_key: string;
  };
  readonly warnings?: readonly string[];
}

export async function generateGeneralTalentContactDraft(
  input: GeneralTalentContactDraftInput,
): Promise<GeneralTalentContactDraft> {
  return apiClient.post<GeneralTalentContactDraft>(
    '/v1/communications/email-drafts/general-contact',
    input,
  );
}

export async function getMicrosoftProviderStatus(): Promise<MicrosoftProviderStatus> {
  return apiClient.get<MicrosoftProviderStatus>('/v1/integrations/microsoft/status');
}

/** PART B — tenant-admin create/update of the Microsoft connection (integration:write). */
export async function configureMicrosoft(input: ConfigureMicrosoftInput): Promise<MicrosoftProviderStatus> {
  return apiClient.post<MicrosoftProviderStatus>('/v1/integrations/microsoft/configure', input);
}
