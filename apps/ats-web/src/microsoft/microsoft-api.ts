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
  readonly requisition_id: string;
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
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotency_key: string;
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
  };
  readonly warnings?: readonly string[];
}

export async function getMicrosoftBindingStatus(): Promise<MicrosoftBindingStatus> {
  return apiClient.get<MicrosoftBindingStatus>('/v1/integrations/microsoft/me');
}

export async function startMicrosoftAuthorize(): Promise<{ authorize_url: string }> {
  return apiClient.get<{ authorize_url: string }>('/v1/integrations/microsoft/authorize/start');
}

export async function sendMicrosoftEmail(input: SendEmailInput): Promise<MicrosoftEmailSendResult> {
  return apiClient.post<MicrosoftEmailSendResult>('/v1/integrations/microsoft/email', input);
}

export async function createMicrosoftMeeting(input: CreateMeetingInput): Promise<MicrosoftMeetingResult> {
  return apiClient.post<MicrosoftMeetingResult>('/v1/integrations/microsoft/meeting', input);
}

export async function generateRequisitionContactDraft(
  input: RequisitionContactDraftInput,
): Promise<RequisitionContactDraft> {
  return apiClient.post<RequisitionContactDraft>(
    '/v1/communications/email-drafts/requisition-contact',
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
