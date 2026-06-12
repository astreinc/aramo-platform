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
