import type {
  CreateTalentRecordRequest,
  ResumeExtractionMode,
  TalentRecordPrefill,
  WorkHistoryDraft,
} from './types';
import type { Provenance, ProvenanceMap } from './provenance';

// The Add-Talent intake field model + body construction.
//
// This is the CREATE-side field set rendered to mockup parity (Identity /
// Contact / Location / Talent-stated / Skills / Notes). It is intentionally
// the mockup's subset of the full TalentRecord — fields the mockup doesn't
// show (address2, best_time_to_call) stay editable on the EDIT form. Every
// field here maps 1:1 to a real CreateTalentRecordRequest key.

export interface IntakeState {
  first_name: string;
  last_name: string;
  current_employer: string;
  email1: string;
  email2: string;
  phone_cell: string;
  phone_home: string;
  phone_work: string;
  web_site: string;
  best_time_to_call: string;
  title: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  availability_status: string;
  engagement_type: string;
  work_authorization: string;
  date_available: string;
  current_pay: string;
  desired_pay: string;
  source: string;
  notes: string;
  // R5 §2 — key_skills is FREE TEXT (a textarea the recruiter reviews/corrects),
  // NOT a structured skill picker. The canonical TalentSkillEvidence is Core-only
  // and NOT recruiter-facing (R5 §0/§6/§8).
  key_skills: string;
  can_relocate: boolean;
  is_hot: boolean;
}

// The string-valued keys (everything except the two booleans) — the set that
// carries resume provenance + the omit-vs-empty discipline.
export const INTAKE_TEXT_KEYS: ReadonlyArray<
  Exclude<keyof IntakeState, 'can_relocate' | 'is_hot'>
> = [
  'first_name',
  'last_name',
  'current_employer',
  'email1',
  'email2',
  'phone_cell',
  'phone_home',
  'phone_work',
  'web_site',
  'best_time_to_call',
  'title',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'country',
  'availability_status',
  'engagement_type',
  'work_authorization',
  'date_available',
  'current_pay',
  'desired_pay',
  'source',
  'notes',
  'key_skills',
];

// The resume prefill populates these keys (the parser's stated-fact surface —
// libs/resume-parse field-extractor). `key_skills` is DELIBERATELY EXCLUDED:
// the deterministic section extractor (extractSection over SKILLS_HEADER_RE)
// over-captures on real résumés with no clean section boundary — it swallows
// the entire body (skills + work experience) into one blob. Auto-filling that
// is worse than empty. key_skills stays a free-text field the recruiter fills
// (R5 §2); clean, structured skill extraction is the governed-LLM surface,
// gated on a filed directive (ADR-0015 v1.3 is scoped to the Core scoring
// layer, not the recruiter form — see the HALT note).
const PREFILL_TEXT_KEYS: ReadonlyArray<keyof IntakeState> = [
  'first_name',
  'last_name',
  'current_employer',
  'email1',
  'email2',
  'phone_cell',
  'phone_home',
  'phone_work',
  'web_site',
  'title',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  // Governed-LLM draft may propose country (grounded). Deterministic parser
  // never populates it — harmless when absent.
  'country',
];

export function emptyIntakeState(): IntakeState {
  return {
    first_name: '',
    last_name: '',
    current_employer: '',
    email1: '',
    email2: '',
    phone_cell: '',
    phone_home: '',
    phone_work: '',
    web_site: '',
    best_time_to_call: '',
    title: '',
    address: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    country: 'US', // B2 — default USA for all talent
    availability_status: '',
    engagement_type: '',
    work_authorization: '',
    date_available: '',
    current_pay: '',
    desired_pay: '',
    source: '',
    notes: '',
    key_skills: '',
    can_relocate: false,
    is_hot: false,
  };
}

export interface PrefillApplication {
  readonly state: IntakeState;
  readonly provenance: ProvenanceMap;
}

// Apply a resume prefill onto a fresh/empty state. Only keys present in the
// prefill are populated, each tagged provenance 'resume' (key_skills included —
// the raw free-text section, per R5 §2). Applied once on a clean intake — the
// recruiter then edits; edits flip provenance to 'edited' in the view.
export function applyPrefill(
  base: IntakeState,
  prefill: TalentRecordPrefill,
  mode: ResumeExtractionMode,
): PrefillApplication {
  const state: IntakeState = { ...base };
  const provenance: ProvenanceMap = {};
  // MODE IS EXCLUSIVE — the prefill came from exactly one extractor; the
  // provenance chip is honest about which (§16).
  const source: Provenance = mode === 'governed_llm' ? 'governed_llm' : 'deterministic';
  for (const key of PREFILL_TEXT_KEYS) {
    const v = (prefill as Record<string, unknown>)[key];
    if (typeof v === 'string' && v !== '') {
      (state as unknown as Record<string, string>)[key] = v;
      provenance[key] = source;
    }
  }
  // key_skills is applied ONLY in governed mode. The deterministic parser's
  // key_skills over-captures the résumé body (garbage — deliberately not
  // prefilled); the governed extractor returns clean, grounded skills that flow
  // into the R5 §2 free-text field.
  if (
    mode === 'governed_llm' &&
    typeof prefill.key_skills === 'string' &&
    prefill.key_skills !== ''
  ) {
    state.key_skills = prefill.key_skills;
    provenance['key_skills'] = source;
  }
  return { state, provenance };
}

// Mark a field 'edited' if it previously came from the resume. A field with
// no prior provenance (recruiter-entered) carries none.
export function provenanceAfterEdit(prev: Provenance | undefined): Provenance | undefined {
  if (prev === 'governed_llm' || prev === 'deterministic' || prev === 'edited') return 'edited';
  return undefined;
}

// Build the POST /v1/talent-records body. Required: first/last name.
// Optional strings omitted when empty (the BE treats absent as "not set").
export function buildCreateBody(
  state: IntakeState,
  workHistory: readonly WorkHistoryDraft[] = [],
): CreateTalentRecordRequest {
  const body: Record<string, unknown> = {
    first_name: state.first_name.trim(),
    last_name: state.last_name.trim(),
  };
  for (const key of INTAKE_TEXT_KEYS) {
    if (key === 'first_name' || key === 'last_name') continue;
    const v = state[key];
    // key_skills is free text (R5 §2) — preserve interior newlines/commas; only
    // trim the outer whitespace, same as every other text field.
    if (typeof v === 'string' && v.trim() !== '') body[key] = v.trim();
  }
  if (state.can_relocate) body['can_relocate'] = true;
  if (state.is_hot) body['is_hot'] = true;
  // Reviewed work-history — only entries with the required employer + role
  // (the recruiter may have cleared a row). Persisted as TalentWorkHistoryEntry.
  const wh = workHistory.filter(
    (e) => e.employer_name.trim() !== '' && e.role_title.trim() !== '',
  );
  if (wh.length > 0) body['work_history'] = wh;
  return body as unknown as CreateTalentRecordRequest;
}
