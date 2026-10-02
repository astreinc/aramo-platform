// Narrow READ PORTS the Talent360Service composes over. Each port is the
// minimal row shape the person-centric projection needs from an owning
// aggregate — NOT the full domain view. The concrete adapter
// (talent-360.adapters.ts) wraps the real repositories/services to satisfy
// these; the service depends only on the ports, so its composition/derivation
// logic is unit-testable with in-memory fakes (no Testcontainers). This keeps
// Talent 360 a READ projection with zero domain authority (directive §4/§32),
// mirroring the My Desk MyDeskReadPort precedent.

import type { VisibilityContextShape } from '@aramo/common';

import type { TalentRequisitionJourney } from '../talent-journey/dto/talent-journey.view.js';

// The authenticated, visibility-resolved actor context handed to every port.
// tenant_id / user_id come from the token; the visibility sets are resolved
// server-side (null = see-all short-circuit). `scopes` is the caller's held
// scope set — the service gates each composed section on the contributing
// domain's scope so composition can never broaden access (directive §17.8). No
// client-supplied identifiers ever (directive §24).
export interface Talent360ActorContext {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly site_id?: string;
  readonly visibility: VisibilityContextShape;
  readonly visible_requisition_ids: ReadonlySet<string> | null;
  readonly visible_contact_ids: ReadonlySet<string> | null;
  readonly scopes: ReadonlySet<string>;
  readonly request_id: string;
}

// The core Talent record fields the header/profile/relationship sections need
// (the findById detail projection subset). recruiting_ready is the landed
// derived boolean (HALT-1: shipped as-is). record_status drives the superseded
// redirect (§17.10). consent_summary is composed separately (not on findById).
export interface TalentCoreRow {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly title: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly email1: string | null;
  readonly phone_cell: string | null;
  readonly work_authorization: string | null;
  readonly desired_pay: string | null;
  readonly current_pay: string | null;
  readonly engagement_type: string | null;
  readonly availability_status: string | null;
  readonly date_available: string | null;
  readonly key_skills: string | null;
  readonly source: string | null;
  readonly owner_id: string | null;
  readonly created_at: string;
  readonly recruiting_ready: boolean;
  readonly record_status: 'live' | 'superseded';
  readonly superseded_by_record_id: string | null;
}

// A pipeline episode (talent × requisition), active OR terminal. From
// PipelineView (id/requisition_id/status/created_at/updated_at).
export interface EpisodeRow {
  readonly id: string;
  readonly requisition_id: string;
  // Canonical PipelineStatus (no_contact … qualified | not_in_consideration |
  // completed | voided).
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// A requisition's lean summary (from RequisitionRepository.findSummariesByIds).
export interface RequisitionSummaryRow {
  readonly id: string;
  readonly requisition_number: number;
  readonly title: string;
  readonly company_id: string;
  readonly status: string;
  readonly is_hot: boolean;
  readonly owner_id: string | null;
  readonly recruiter_id: string | null;
}

// The latest interview session for a client-selection process — carries the
// scheduled_at the KPI/attention "interview today" derivation needs (the
// journey composer exposes only interview_state, not the instant).
export interface InterviewScheduleRow {
  readonly scheduled_at: string;
  readonly state: string;
  readonly interview_type: string;
  readonly round: number;
}

// The most-recent authoritative contact (top-1 CommunicationInteraction by
// created_at) — the Last Contact KPI. channel is the interaction channel.
export interface LastContactRow {
  readonly at: string;
  readonly channel: string;
}

// A recent communication interaction for the unified activity timeline.
export interface CommunicationRow {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly created_at: string;
}

// A recent activity-log entry for the unified timeline.
export interface ActivityRow {
  readonly id: string;
  readonly type: string;
  readonly notes: string | null;
  readonly created_by_id: string | null;
  readonly created_at: string;
}

// A human-created task owned by this Talent (from TaskRepository.listForOwner).
export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly due_date: string | null;
}

// A Talent-associated document (from DocumentsRepository.listForTalent). signed
// = status==='EXECUTED'; signed_at = executed_at (documents-schema authority).
export interface DocumentRow {
  readonly id: string;
  readonly title: string;
  readonly document_type_key: string;
  readonly document_type_name: string;
  readonly status: string;
  readonly executed_at: string | null;
  readonly created_at: string;
  readonly regarding_requisition_id: string | null;
}

export type ConsentSummaryValue =
  | 'contactable'
  | 'expiring_lt_30d'
  | 'do_not_contact';

// Recruiter-facing identity OUTCOMES (from DossierService) — never the internal
// trust machinery (directive §14). advisory = a pending same-Talent duplicate.
export interface IdentityOutcomeRow {
  readonly primary_email_confirmed: boolean;
  readonly mobile_confirmed: boolean;
  readonly advisory: { readonly advisory_id: string; readonly label: string } | null;
}

// A declared work-history entry (from TalentExtractionService).
export interface WorkHistoryRow {
  readonly employer_name: string;
  readonly role_title: string;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly employment_type: string | null;
  readonly source: string;
}

export interface Talent360ReadPort {
  // Core Talent record (detail projection). null ⇒ absent/cross-tenant.
  loadTalent(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<TalentCoreRow | null>;

  // ALL episodes for the Talent (active + terminal), visibility-scoped. Bounded.
  listEpisodes(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly EpisodeRow[]>;

  // The authoritative per-episode journey (owner-attributed, GET-only) — reused
  // for inline opportunity expansion + KPI/attention derivation. Never
  // re-derives a downstream stage.
  composeJourney(
    ctx: Talent360ActorContext,
    pipeline_id: string,
  ): Promise<TalentRequisitionJourney>;

  resolveRequisitions(
    ctx: Talent360ActorContext,
    requisition_ids: readonly string[],
  ): Promise<ReadonlyMap<string, RequisitionSummaryRow>>;

  resolveCompanyNames(
    ctx: Talent360ActorContext,
    company_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  resolveUserNames(
    ctx: Talent360ActorContext,
    user_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  // CRM-5 §9.5 — authoritative terminal reason per (closed) pipeline id; absent
  // ⇒ "reason not recorded" (null) at the composition layer. Reason only, never
  // the free-text disposition note.
  resolveDispositionReasons(
    ctx: Talent360ActorContext,
    pipeline_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  // Latest interview for a client-selection process (the scheduled_at source).
  findLatestInterview(
    ctx: Talent360ActorContext,
    client_selection_process_id: string,
  ): Promise<InterviewScheduleRow | null>;

  // Top-1 most-recent interaction (the Last Contact KPI). null ⇒ none.
  lastContact(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<LastContactRow | null>;

  listRecentCommunications(
    ctx: Talent360ActorContext,
    talent_id: string,
    limit: number,
  ): Promise<readonly CommunicationRow[]>;

  listRecentActivity(
    ctx: Talent360ActorContext,
    talent_id: string,
    limit: number,
  ): Promise<readonly ActivityRow[]>;

  listTasks(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly TaskRow[]>;

  listDocuments(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly DocumentRow[]>;

  loadConsentSummary(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<ConsentSummaryValue>;

  loadIdentityOutcomes(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<IdentityOutcomeRow>;

  listWorkHistory(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly WorkHistoryRow[]>;
}

export const TALENT_360_READ_PORT = 'TALENT_360_READ_PORT';
