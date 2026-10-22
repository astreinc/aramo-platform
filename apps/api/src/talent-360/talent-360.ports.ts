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
  // The interaction lifecycle status (e.g. a meeting's scheduled/rescheduled/
  // cancelled, or a create-link-only meeting's `created`).
  readonly status: string;
  // The stored subject (email subject / scheduled-meeting title); null when the
  // writer stored none (voice, create-link-only meetings, legacy sends).
  readonly subject: string | null;
  // The meeting window for meeting-channel rows; null otherwise.
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly initiated_by_id: string | null;
  // `regarding` requisition associations (association truth). NOT pre-filtered
  // by visibility — the service resolves them through resolveRequisitions.
  readonly requisition_ids: readonly string[];
  readonly created_at: string;
}

// A single email interaction for the recruiter-facing preview: the FINAL sent
// subject/body (COMM-C4 durable evidence) + addressing. Only returned when the
// interaction is associated to the Talent as its `subject`.
export interface CommunicationPreviewRow {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly status: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly from_address: string;
  readonly to_address: string;
  readonly initiated_by_id: string | null;
  readonly requisition_ids: readonly string[];
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

// ATS-QA-1 D1/D2 — a pipeline milestone (Activity type `pipeline_status_change`,
// subject_type 'pipeline', subject_id = the episode id) for one of the Talent's
// VISIBLE episodes. Carries the episode's requisition so the item can be scoped to
// that requisition (Talent × Requisition 360). `notes` is the durable system text
// (`pipeline <from> -> <to>[: note]…`) exactly as written — historical stage keys
// are preserved; the recruiter-facing wording is applied at display time.
export interface PipelineActivityRow {
  readonly id: string;
  readonly pipeline_id: string;
  readonly requisition_id: string;
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

// ATS-QA-1 I-4 — one CURRENT declared education entry (TalentEducationRepository).
export interface EducationRow {
  readonly id: string;
  readonly institution_name: string;
  readonly degree_name: string;
  readonly field_of_study: string | null;
  readonly conferred_date: string | null;
  readonly source: 'resume' | 'manual' | 'import';
  readonly source_document_id: string | null;
  readonly source_refs: readonly string[];
  readonly corrects_entry_id: string | null;
  readonly recorded_at: string;
}

// A Talent document's file for the read-only preview: the bytes of its content
// artifact (executed > prepared > original upload) + the REGARDING requisition ids
// so the service can apply visibility. null ⇒ absent / not this Talent's / no file.
export interface DocumentContentRow {
  readonly document_id: string;
  readonly title: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly regarding_requisition_ids: readonly string[];
  // Lazily read so the service can refuse (visibility / size) before any bytes move.
  readonly readBytes: () => Promise<Buffer>;
}

// DI token for the DocumentStoragePort bound locally in Talent360Module (the
// documents root binding is not exported to sub-modules — the documents-esign
// module precedent).
export const TALENT_360_DOCUMENT_STORAGE = 'TALENT_360_DOCUMENT_STORAGE';

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

  // One interaction for the preview, tenant-scoped AND constrained to the Talent
  // (`subject` association). null ⇒ absent / cross-tenant / not this Talent's.
  loadCommunicationPreview(
    ctx: Talent360ActorContext,
    talent_id: string,
    interaction_id: string,
  ): Promise<CommunicationPreviewRow | null>;

  // A Talent document's content for the read-only preview (SUBJECT-associated
  // to this Talent). Tenant-scoped. null ⇒ absent / not this Talent's / no file.
  loadDocumentContent(
    ctx: Talent360ActorContext,
    talent_id: string,
    document_id: string,
  ): Promise<DocumentContentRow | null>;

  listRecentActivity(
    ctx: Talent360ActorContext,
    talent_id: string,
    limit: number,
  ): Promise<readonly ActivityRow[]>;

  // ATS-QA-1 D1/D2 — pipeline milestones for the given episodes ONLY. The caller
  // passes episodes already scoped to requisitions the viewer may see (listEpisodes
  // + resolveRequisitions); the adapter additionally applies the activity
  // repository's pipeline-visibility predicate over exactly those episode ids.
  listPipelineActivity(
    ctx: Talent360ActorContext,
    episodes: readonly EpisodeRow[],
    limit: number,
  ): Promise<readonly PipelineActivityRow[]>;

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

  // ATS-QA-1 I-4 — the Talent's CURRENT declared education, tenant-scoped.
  listEducation(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly EducationRow[]>;
}

export const TALENT_360_READ_PORT = 'TALENT_360_READ_PORT';
