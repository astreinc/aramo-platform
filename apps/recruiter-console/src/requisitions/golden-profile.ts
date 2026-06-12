// Hand-mirrored from the Job-Module BE GoldenProfileContent contract.
// The AI "Generate profile from brief" flow drafts a GoldenProfile from a
// recruiter's free-text brief; the recruiter reviews/edits it and confirms.
// Manual entry remains possible — the AI is assistive, never required.

export interface GoldenProfileSkill {
  name: string;
  min_years?: number;
}

export interface GoldenProfileContent {
  role_family?: string;
  seniority_level?: string;
  jd_text: string;
  generated_by: 'manual' | 'ai_draft';
  required_skills: GoldenProfileSkill[];
  preferred_skills: { name: string }[];
  critical_skills: GoldenProfileSkill[];
  experience: {
    total_years?: number;
    domain?: string;
    industries: string[];
  };
  constraints: {
    location?: string;
    work_mode?: string;
    rate?: string;
    work_authorization?: string;
  };
}

// PR-A2 P3 — hand-mirrored from libs/requisition/src/lib/dto/requisition-
// profile.view.ts (RequisitionProfileView). The first-class profile READ
// shape returned by GET /v1/requisitions/:id/profile: the un-nested
// GoldenProfile content + the requisition-side metadata the workbench needs.
// has_profile === false is the profile-less shape (no profile confirmed yet)
// — generated_by is null then, distinguishing it from a manual profile.
export interface RequisitionProfileView {
  readonly requisition_id: string;
  readonly golden_profile_id: string | null;
  readonly has_profile: boolean;
  readonly jd_text: string;
  readonly role_family: string | null;
  readonly seniority_level: string | null;
  readonly generated_by: 'manual' | 'ai_draft' | null;
  readonly required_skills: GoldenProfileSkill[];
  readonly preferred_skills: { name: string }[];
  readonly critical_skills: GoldenProfileSkill[];
  readonly experience: {
    total_years?: number;
    domain?: string;
    industries: string[];
  };
  readonly constraints: {
    location?: string;
    work_mode?: string;
    rate?: string;
    work_authorization?: string;
  };
}

// Reconstitute an editable GoldenProfileContent from the read view (for the
// inline-edit save path — confirm wants the full content envelope). An
// inline operator edit marks the profile generated_by:'manual' (a hand-edit
// is no longer purely AI), so confirm needs no draft_event_id.
export function profileViewToContent(
  view: RequisitionProfileView,
): GoldenProfileContent {
  return {
    role_family: view.role_family ?? undefined,
    seniority_level: view.seniority_level ?? undefined,
    jd_text: view.jd_text,
    generated_by: 'manual',
    required_skills: view.required_skills,
    preferred_skills: view.preferred_skills,
    critical_skills: view.critical_skills,
    experience: view.experience,
    constraints: view.constraints,
  };
}

// --- Wire request/response shapes for the draft → confirm endpoints. ---

export interface DraftProfileRequest {
  readonly brief: string;
}

export interface DraftProfileResponse {
  readonly draft_event_id: string;
  readonly jd_text: string;
  readonly golden_profile_draft: GoldenProfileContent;
  readonly ai_draft_audit_record_id: string;
}

export interface ConfirmProfileRequest {
  readonly draft_event_id: string;
  readonly jd_text: string;
  readonly golden_profile: GoldenProfileContent;
}

// --- Small helpers for the comma/line skill-list editing UI. ---

// Parse a comma-or-newline list of skill names into {name, min_years?}
// objects. Blank entries are dropped; min_years is omitted (the simple
// editor edits names only).
export function parseSkillList(raw: string): GoldenProfileSkill[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => ({ name }));
}

export function parsePreferredSkillList(raw: string): { name: string }[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => ({ name }));
}

// Render a skill list back to a comma-separated string for the textarea.
export function skillListToText(
  skills: ReadonlyArray<{ name: string }>,
): string {
  return skills.map((s) => s.name).join(', ');
}

export function parseIndustryList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// A blank manual draft — the starting point when the recruiter edits a
// profile without invoking the AI.
export function emptyGoldenProfile(): GoldenProfileContent {
  return {
    jd_text: '',
    generated_by: 'manual',
    required_skills: [],
    preferred_skills: [],
    critical_skills: [],
    experience: { industries: [] },
    constraints: {},
  };
}
