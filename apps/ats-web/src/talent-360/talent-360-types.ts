// Hand-mirror of apps/api/src/talent-360/dto/talent-360.view.ts (Talent360View).
//
// ats-web HAND-MIRRORS backend read DTOs — it never imports @aramo/* domain libs
// (the FROZEN fe-foundation discipline; same pattern as dashboard/my-desk-types).
// Talent 360 is a READ PROJECTION: the FE renders what getTalent360 composed and
// NEVER re-derives server-owned truth (waiting duration, interview-today,
// recruiting-ready, contactability, ownership, identity advisory, signed-doc
// state, KPI counts all come from this payload). The FE owns only presentation
// state (expand/collapse, active tab, drawer open/close, loading/empty/error).
//
// CONTRACT — partial-page by scope: a scope-gated section is `null` when the
// caller lacks the contributing scope (authorization-hidden), and an object with
// empty arrays / 0 counts when authorized-but-empty. `authorized_sections`
// records which were composed.

export interface TalentAvailabilityView {
  readonly status: string | null;
  readonly detail: string | null;
}

export interface RecruitingReadyView {
  readonly ready: boolean;
  readonly rule: string;
}

export interface ContactabilityView {
  readonly summary: 'contactable' | 'expiring_lt_30d' | 'do_not_contact';
  readonly recruiting_permitted: boolean;
  readonly email_permitted: boolean;
  readonly phone_permitted: boolean;
  readonly sms_permitted: boolean;
}

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
  readonly title: string | null;
  readonly location: string | null;
  readonly experience_summary: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly work_authorization: string | null;
  readonly desired_compensation: string | null;
  readonly engagement_type: string | null;
  readonly availability: TalentAvailabilityView;
  readonly recruiting_ready: RecruitingReadyView;
  readonly contactability: ContactabilityView;
  readonly actions: TalentActionCapabilities;
  readonly record_status: 'live' | 'superseded';
  readonly superseded_by_record_id: string | null;
}

export interface LastContactView {
  readonly at: string;
  readonly channel: string;
}

export interface RelationshipStripView {
  readonly active_opportunities: number | null;
  readonly submittals: number | null;
  readonly interviews_today: number | null;
  readonly offers: number | null;
  readonly assignments: number | null;
  readonly last_contact: LastContactView | null;
}

export interface OpportunityActionView {
  readonly kind: string;
  readonly label: string;
  readonly href: string | null;
}

// The per-episode journey mirrors GET /v1/pipelines/:id/journey — a SUMMARY the
// expansion renders, never a second state machine. Kept loosely typed (the FE
// reads the fields it displays; it does not re-derive the journey).
export interface JourneyStageElement {
  readonly stage: string;
  readonly owner: string;
  readonly source_object_id: string;
  readonly occurred_at?: string;
}

export interface JourneySubStates {
  readonly pipeline_stage: string | null;
  readonly submittal_state: string | null;
  readonly selection_state: string | null;
  readonly interview_state: string | null;
  readonly offer_state: string | null;
  readonly placement_state: string | null;
  readonly pre_start_state: string | null;
  readonly assignment_state: string | null;
}

export interface JourneyAction {
  readonly action: string;
  readonly owner: string;
  readonly command_route: string;
}

export interface TalentRequisitionJourney {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly current_journey_stage: string;
  readonly stages: readonly JourneyStageElement[];
  readonly sub_states: JourneySubStates;
  readonly actions: readonly JourneyAction[];
}

export interface ActiveOpportunityView {
  readonly pipeline_id: string;
  readonly requisition_id: string;
  readonly requisition_code: string;
  readonly client_name: string | null;
  readonly role_title: string | null;
  readonly stage: string;
  readonly contextual_state: string | null;
  readonly age_label: string | null;
  readonly owner_label: string | null;
  readonly next_action: OpportunityActionView | null;
  readonly journey: TalentRequisitionJourney;
  readonly open_journey_href: string;
}

export interface ClosedOpportunityView {
  readonly pipeline_id: string;
  readonly requisition_id: string;
  readonly requisition_code: string;
  readonly client_name: string | null;
  readonly role_title: string | null;
  readonly outcome: string;
  readonly closed_at: string | null;
  readonly open_journey_href: string;
}

export interface OpportunitiesView {
  readonly active: readonly ActiveOpportunityView[];
  readonly closed: readonly ClosedOpportunityView[];
}

export interface AttentionItemView {
  readonly id: string;
  readonly kind: string;
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly action: OpportunityActionView | null;
}

export interface TalentTaskView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly due_date: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
}

export interface RecentActivityItemView {
  readonly id: string;
  readonly occurred_at: string;
  readonly category: string;
  readonly title: string;
  readonly body: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly actor_label: string | null;
  readonly channel: string | null;
}

export interface RecentActivityView {
  readonly items: readonly RecentActivityItemView[];
  readonly category_counts: Readonly<Record<string, number>>;
  readonly has_more: boolean;
}

export interface ProfileFactView {
  readonly label: string;
  readonly value: string;
  readonly source: string | null;
}

export interface ProfileSkillView {
  readonly label: string;
  readonly verified: boolean;
}

export interface WorkHistoryEntryView {
  readonly role: string;
  readonly organization: string;
  readonly span: string;
  readonly source: string | null;
}

export interface ProfileView {
  readonly summary: string | null;
  readonly facts: readonly ProfileFactView[];
  readonly skills: readonly ProfileSkillView[];
  readonly work_history: readonly WorkHistoryEntryView[];
}

export interface TalentDocumentView {
  readonly id: string;
  readonly kind: string;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly meta: string | null;
  readonly signed: boolean;
  readonly signed_at: string | null;
}

export interface DocumentsView {
  readonly key_documents: readonly TalentDocumentView[];
  readonly total: number;
}

export interface IdentityAdvisoryView {
  readonly advisory_id: string;
  readonly label: string;
}

export interface IdentityView {
  readonly primary_email_confirmed: boolean;
  readonly mobile_confirmed: boolean;
  readonly advisory: IdentityAdvisoryView | null;
}

export interface RelationshipHistoryView {
  readonly known_since: string | null;
  readonly requisitions: number;
  readonly submittals: number;
  readonly interviews: number;
  readonly placements: number;
}

export interface OwnershipContactView {
  readonly user_id: string;
  readonly name: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
}

export interface OwnershipView {
  readonly owner_provenance: { readonly user_id: string; readonly name: string | null } | null;
  readonly also_working_with: readonly OwnershipContactView[];
  readonly source: string | null;
  readonly source_channel: string | null;
}

export interface RelationshipView {
  readonly history: RelationshipHistoryView;
  readonly ownership: OwnershipView;
}

export interface Talent360AuthorizedSections {
  readonly opportunities: boolean;
  readonly attention: boolean;
  readonly tasks: boolean;
  readonly activity: boolean;
  readonly communications: boolean;
  readonly documents: boolean;
  readonly identity: boolean;
}

export interface Talent360View {
  readonly generated_at: string;
  readonly server_date: string;
  readonly header: TalentHeaderView;
  readonly relationship_strip: RelationshipStripView;
  readonly opportunities: OpportunitiesView | null;
  readonly attention: readonly AttentionItemView[] | null;
  readonly tasks: readonly TalentTaskView[] | null;
  readonly recent_activity: RecentActivityView | null;
  readonly documents: DocumentsView | null;
  readonly identity: IdentityView | null;
  readonly profile: ProfileView;
  readonly relationship: RelationshipView;
  readonly authorized_sections: Talent360AuthorizedSections;
}
