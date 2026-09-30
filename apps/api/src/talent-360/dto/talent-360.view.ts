// Talent360View — the recruiter-facing person-centric read PROJECTION
// (GET /v1/talent-360/:talentId).
//
// This is a READ COMPOSITION over existing authorities (Talent / Pipeline /
// Submittal / ClientSelection / Interview / Offer / Placement / Communications /
// Task / Activity / Documents+esign / Consent / Talent-Trust). It creates NO
// state, owns NO invariant, and derives NO verdict a domain does not already own
// (directive §4/§32). apps/api is the only layer permitted to know all owners
// (the My Desk / Talent Journey precedent) — this DTO never leaves the boundary
// with an internal domain object.
//
// AUTHORITY / AUTHORIZATION shape (directive §17.8): every optional section is
// nullable. `null` means "the caller does not hold the contributing domain's
// scope, so the section was not composed" (authorization-hidden) — distinct from
// an empty array, which means "authorized, but the Talent has none" (the honest
// empty state, directive §24). The FE renders nothing for a null section and the
// prototype's empty-state copy for an empty one. Composition can therefore never
// broaden access beyond any contributing domain.
//
// Vocabulary: canonical `Talent` / `submittal` only; the Tier-2 replacements are
// enforced by scripts/verify-vocabulary.sh. No numeric trust/priority ordinal
// appears anywhere (R10 / R4).

import type { RecruitingStatus } from '@aramo/requisition';

import type { TalentRequisitionJourney } from '../../talent-journey/dto/talent-journey.view.js';

// ---------------------------------------------------------------------------
// Header — identity, contact, condition badges
// ---------------------------------------------------------------------------

// The three recruiter-facing header conditions the prototype shows. Each is an
// OUTCOME of an existing authority, never a Talent-stored flag.
export interface TalentAvailabilityView {
  // Raw availability_status enum (e.g. available_now / passive / not_looking);
  // the FE maps to the prototype badge copy ("Available now").
  readonly status: string | null;
  // A short authoritative qualifier where one exists (e.g. "Current contract
  // ends Sep 30"); null when nothing authoritative qualifies it.
  readonly detail: string | null;
}

// recruiting_ready is SHIPPED AS-IS (HALT-1 ruling): the landed predicate is
// `live && hasContact(email1|phone_cell) && work_authorization != null`,
// informational only. `rule` carries the honest human description the tooltip
// renders — it MUST describe the real predicate, never the prototype's stronger
// consent/identity promise (no consent or advisory semantics are added here).
export interface RecruitingReadyView {
  readonly ready: boolean;
  readonly rule: string;
}

// Contactability = the consent authority's outcome (directive §6.6). NEVER
// inferred from the presence of an email/phone. `summary` is the 3-value consent
// band; the per-channel permits mirror the consent scopes the prototype rail
// shows. null on any channel = the consent authority does not permit it.
export interface ContactabilityView {
  // 'contactable' | 'expiring_lt_30d' | 'do_not_contact'
  readonly summary: string;
  readonly recruiting_permitted: boolean;
  readonly email_permitted: boolean;
  readonly phone_permitted: boolean;
  readonly sms_permitted: boolean;
}

// Which header/section actions the backend domains currently PERMIT (directive
// §8.4 — never expose an action a domain refuses). The FE reuses the existing
// flow for each; this only gates visibility. Email/Call additionally respect
// consent (contactability), not just scope.
export interface TalentActionCapabilities {
  readonly can_email: boolean;
  readonly can_call: boolean;
  readonly can_add_to_requisition: boolean;
  readonly can_log_activity: boolean;
  readonly can_edit_profile: boolean;
}

export interface TalentHeaderView {
  readonly talent_id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly display_name: string;
  // Role/title summary (e.g. "Scrum Master / Product Owner").
  readonly title: string | null;
  // "Vienna, VA" style location label composed from city/state; null if absent.
  readonly location: string | null;
  // "11 yrs experience" style summary — nullable: only rendered when an
  // authoritative source (profile hydration / work history span) supplies it.
  readonly experience_summary: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly work_authorization: string | null;
  // Talent-STATED desired compensation (free-text `desired_pay`) + engagement
  // basis (e.g. "C2C"). HALT-3 ruling: displayed with CURRENT behavior — this
  // is not gated by the requisition compensation-mask (which is req-level only);
  // the ungated talent-comp field is recorded as pre-existing authz debt for
  // separate treatment, NOT broadened or newly gated here.
  readonly desired_compensation: string | null;
  readonly engagement_type: string | null;
  readonly availability: TalentAvailabilityView;
  readonly recruiting_ready: RecruitingReadyView;
  readonly contactability: ContactabilityView;
  readonly actions: TalentActionCapabilities;
  // record_status='superseded' ⇒ the FE redirects to superseded_by_record_id
  // (directive §17.10 / §23 — never resurrect a superseded identity). live rows
  // carry superseded_by=null.
  readonly record_status: 'live' | 'superseded';
  readonly superseded_by_record_id: string | null;
}

// ---------------------------------------------------------------------------
// Relationship summary strip (KPIs) — summaries of authoritative state
// ---------------------------------------------------------------------------

export interface LastContactView {
  readonly at: string;
  // The channel of the most-recent authoritative CommunicationInteraction
  // (e.g. "email" / "voice"); the prototype renders "· email".
  readonly channel: string;
}

// Each KPI is a summary that links into its detail (directive §16). Counts are
// derived talent-scoped from the owning domains; a null KPI = its contributing
// domain scope is unheld.
export interface RelationshipStripView {
  // Active (non-terminal) pipeline episodes for this Talent.
  readonly active_opportunities: number | null;
  // Live submittals for this Talent (distinct from placements).
  readonly submittals: number | null;
  // Interviews scheduled for the app-timezone civil "today".
  readonly interviews_today: number | null;
  // Live offers (SENT ∪ NEGOTIATION ∪ ACCEPTED).
  readonly offers: number | null;
  // STARTED placements (HALT-4 ruling: matches My Desk `started` semantics).
  readonly assignments: number | null;
  // Most-recent contact; null when authorized-but-none, absent section when
  // communication:read unheld (see contactability-scoped composition).
  readonly last_contact: LastContactView | null;
}

// ---------------------------------------------------------------------------
// Active opportunities (Talent × Requisition) + closed
// ---------------------------------------------------------------------------

// The compact row + an OPTIONAL inline expansion. The expansion is a SUMMARY of
// the authoritative journey (reused TalentRequisitionJourney), never a second
// journey state machine (directive §3.4). `open_journey_href` routes into the
// existing detailed workflow.
export interface ActiveOpportunityView {
  readonly pipeline_id: string;
  readonly requisition_id: string;
  // "REQ-1001" (presentation-only prefix over requisition_number).
  readonly requisition_code: string;
  readonly client_name: string | null;
  readonly role_title: string | null;
  // The furthest-forward journey stage (from the reused journey composer).
  readonly stage: string;
  // A FACTS-derived contextual line (e.g. "Waiting for client · 3 days" from
  // ClientSelectionProcess.created_at while CLIENT_REVIEW; "Client interview
  // today"). null when nothing beyond the stage qualifies it.
  readonly contextual_state: string | null;
  // Age/wait qualifier where one applies; null otherwise.
  readonly age_label: string | null;
  // The recruiter attributed to THIS opportunity (per-requisition authority —
  // the only authoritative "who is working it"; directive §15 / HALT-2).
  readonly owner_label: string | null;
  // The single most-relevant next action the owning domain permits, or null.
  readonly next_action: OpportunityActionView | null;
  // Inline expansion — the reused authoritative journey (owner-attributed,
  // GET-only). null until the FE requests expansion is not needed: the payload
  // includes it inline (bounded — one journey per active episode).
  readonly journey: TalentRequisitionJourney;
  // Route into the authoritative Talent × Requisition workflow.
  readonly open_journey_href: string;
}

export interface OpportunityActionView {
  // Names an EXISTING owning-domain command/route the FE reuses; the projection
  // never mutates and never mirrors a business rule client-side.
  readonly kind: string;
  readonly label: string;
  readonly href: string | null;
}

export interface ClosedOpportunityView {
  readonly pipeline_id: string;
  readonly requisition_id: string;
  readonly requisition_code: string;
  readonly client_name: string | null;
  readonly role_title: string | null;
  // Terminal outcome label (e.g. "Not selected" / "Withdrew" / "Completed").
  readonly outcome: string;
  readonly closed_at: string | null;
  readonly open_journey_href: string;
}

export interface OpportunitiesView {
  readonly active: readonly ActiveOpportunityView[];
  readonly closed: readonly ClosedOpportunityView[];
}

// ---------------------------------------------------------------------------
// FROM ARAMO — system-derived attention (directive §9)
// ---------------------------------------------------------------------------

// Derived from live domain state; self-clearing (no persistent attention store).
// Each item retains its requisition context and routes to an existing action.
export interface AttentionItemView {
  readonly id: string;
  // 'interview' | 'blocking' | 'waiting' | 'next_step' | 'identity'
  readonly kind: string;
  // Small eyebrow label ("TODAY · 4:00 PM", "WAITING 3 DAYS", "IDENTITY").
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly action: OpportunityActionView | null;
}

// ---------------------------------------------------------------------------
// FROM PEOPLE — human-created tasks (directive §10)
// ---------------------------------------------------------------------------

export interface TalentTaskView {
  readonly id: string;
  readonly title: string;
  // 'open' | 'in_progress' | 'waiting' | 'done' | 'cancelled'
  readonly status: string;
  readonly due_date: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
}

// ---------------------------------------------------------------------------
// Recent activity — unified, composed (directive §11)
// ---------------------------------------------------------------------------

// One recent event across the authoritative sources (communications + activity
// log + journey/document events), each retaining requisition context. Reuses
// existing authoritative events; builds no second Talent activity ledger.
export interface RecentActivityItemView {
  readonly id: string;
  readonly occurred_at: string;
  // 'communications' | 'requisitions' | 'client' | 'interviews' | 'documents' | 'tasks'
  readonly category: string;
  readonly title: string;
  readonly body: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly actor_label: string | null;
  // Channel for communication events ("email"/"voice"); null otherwise.
  readonly channel: string | null;
}

// Per-category counts drive the filter chips; every count links/filters
// correctly (directive §16). The keys mirror the category union above.
export interface RecentActivityView {
  readonly items: readonly RecentActivityItemView[];
  readonly category_counts: Readonly<Record<string, number>>;
  // Whether more events exist beyond the returned recent window ("View full
  // activity"). The Overview shows only the recent/high-value window (§11/§18).
  readonly has_more: boolean;
}

// ---------------------------------------------------------------------------
// Professional profile (concise; full history behind a link — directive §12)
// ---------------------------------------------------------------------------

export interface ProfileFactView {
  readonly label: string;
  readonly value: string;
  // Subtle provenance where already supported (e.g. "Self-reported · Sep 23");
  // internal evidence-model names are NEVER exposed (directive §12/§14).
  readonly source: string | null;
}

export interface ProfileSkillView {
  readonly label: string;
  // Evidence-backed (verified) vs self-reported — the outcome only, from the
  // trust authority; no band numbers, no internal model names.
  readonly verified: boolean;
}

export interface WorkHistoryEntryView {
  readonly role: string;
  readonly organization: string;
  readonly span: string;
  readonly source: string | null;
}

export interface ProfileView {
  // Professional summary paragraph; null when no authoritative source supplies
  // one (never fabricated to fill the layout — directive §24).
  readonly summary: string | null;
  readonly facts: readonly ProfileFactView[];
  readonly skills: readonly ProfileSkillView[];
  // Detailed work history stays behind "Work history & full profile"; the
  // Overview does not render the entire record (directive §12). Provided here so
  // the Profile tab can render it without a second round-trip.
  readonly work_history: readonly WorkHistoryEntryView[];
}

// ---------------------------------------------------------------------------
// Documents (important/current only; admin stays in Documents — directive §13)
// ---------------------------------------------------------------------------

export interface TalentDocumentView {
  readonly id: string;
  // Recruiter-facing kind label ("Résumé", "RTR · Freddie Mac").
  readonly kind: string;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly meta: string | null;
  // Signature outcome from the Documents/e-sign authority; the Talent surface
  // DISPLAYS the result and never stores signature state (directive §13).
  readonly signed: boolean;
  readonly signed_at: string | null;
}

export interface DocumentsView {
  // Only the key/current documents for the Overview.
  readonly key_documents: readonly TalentDocumentView[];
  // Total across the Documents authority for the "All N documents" link.
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Identity outcomes (recruiter-facing; machinery stays in Trust & Evidence)
// ---------------------------------------------------------------------------

// OUTCOMES only (directive §14) — never ResolutionSubject/EvidenceRecord/etc.
export interface IdentityAdvisoryView {
  readonly advisory_id: string;
  readonly label: string;
}

export interface IdentityView {
  readonly primary_email_confirmed: boolean;
  readonly mobile_confirmed: boolean;
  // A pending same-Talent duplicate advisory, or null. Sourced from the
  // existing advisory authority (SubjectMatchAdvisory) — never a Talent boolean.
  readonly advisory: IdentityAdvisoryView | null;
}

// ---------------------------------------------------------------------------
// Relationship & ownership (directive §15; HALT-2 + HALT-5 rulings)
// ---------------------------------------------------------------------------

// HALT-5: counts are for the SINGLE TalentRecord in this increment. They make NO
// claim to represent merged-human / identity-cluster lifetime history.
export interface RelationshipHistoryView {
  readonly known_since: string | null;
  readonly requisitions: number;
  readonly submittals: number;
  readonly interviews: number;
  readonly placements: number;
}

// HALT-2: there is NO authoritative Talent-level owner concept. `owner_id` is
// PROVENANCE only and is labeled by its actual provenance semantics — never
// presented as an enforced "Talent owner" assignment. `also_working_with` is
// DERIVED from active-opportunity recruiter attribution (the authoritative
// per-requisition owner), excluding the viewing recruiter; never inferred from
// activity.
export interface OwnershipContactView {
  readonly user_id: string;
  readonly name: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
}

export interface OwnershipView {
  // owner_id resolved, labeled as provenance (e.g. "Record owner"), never
  // "Talent owner". null when owner_id is absent.
  readonly owner_provenance: { readonly user_id: string; readonly name: string | null } | null;
  readonly also_working_with: readonly OwnershipContactView[];
  // Free-text sourcing origin (`source`) / closed-vocab `source_channel`.
  readonly source: string | null;
  readonly source_channel: string | null;
}

export interface RelationshipView {
  readonly history: RelationshipHistoryView;
  readonly ownership: OwnershipView;
}

// ---------------------------------------------------------------------------
// Section authorization map (directive §17.8)
// ---------------------------------------------------------------------------

// Explicit record of which scope-gated sections were composed for THIS caller,
// so the FE can distinguish authorization-hidden (false) from authorized-empty
// (true + empty array). Each corresponds to the caller's held domain scope.
export interface Talent360AuthorizedSections {
  readonly opportunities: boolean; // pipeline:read
  readonly attention: boolean; // derived from the sections the caller can see
  readonly tasks: boolean; // task:read
  readonly activity: boolean; // activity:read
  readonly communications: boolean; // communication:read
  readonly documents: boolean; // document:read
  readonly identity: boolean; // talent:read (+ evidence capability)
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface Talent360View {
  // Server clock (ISO) + app-timezone civil date, so the FE never derives
  // "today"/aging from the browser clock (directive §38 precedent).
  readonly generated_at: string;
  readonly server_date: string;

  readonly header: TalentHeaderView;
  readonly relationship_strip: RelationshipStripView;

  // Scope-gated sections. `null` ⇒ authorization-hidden (caller lacks the
  // contributing scope); an empty array ⇒ authorized but the Talent has none.
  readonly opportunities: OpportunitiesView | null;
  readonly attention: readonly AttentionItemView[] | null;
  readonly tasks: readonly TalentTaskView[] | null;
  readonly recent_activity: RecentActivityView | null;
  readonly documents: DocumentsView | null;
  readonly identity: IdentityView | null;

  // Always-present (talent:read) sections.
  readonly profile: ProfileView;
  readonly relationship: RelationshipView;

  readonly authorized_sections: Talent360AuthorizedSections;
  // The requisition status vocabulary is preserved end-to-end; the type import
  // keeps this DTO bound to the canonical enum (no restated string literals).
  readonly _status_vocab?: RecruitingStatus;
}
