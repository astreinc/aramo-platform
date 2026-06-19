import type { CreateTalentRecordRequest, TalentRecordPrefill } from './types';
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
  address: string;
  city: string;
  state: string;
  zip: string;
  availability_status: string;
  engagement_type: string;
  date_available: string;
  current_pay: string;
  desired_pay: string;
  source: string;
  notes: string;
  can_relocate: boolean;
  is_hot: boolean;
}

// The string-valued keys (everything except the two booleans) — the set that
// carries résumé provenance + the omit-vs-empty discipline.
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
  'address',
  'city',
  'state',
  'zip',
  'availability_status',
  'engagement_type',
  'date_available',
  'current_pay',
  'desired_pay',
  'source',
  'notes',
];

// The résumé prefill only ever populates these keys (the parser's stated-fact
// surface — libs/resume-parse field-extractor). `key_skills` is handled
// separately as chips.
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
  'address',
  'city',
  'state',
  'zip',
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
    address: '',
    city: '',
    state: '',
    zip: '',
    availability_status: '',
    engagement_type: '',
    date_available: '',
    current_pay: '',
    desired_pay: '',
    source: '',
    notes: '',
    can_relocate: false,
    is_hot: false,
  };
}

// Free-text skills <-> chips. Stored as the free-text `key_skills` string;
// rendered as chips for parity. Splitting is display-only (no per-skill
// model — the canonical evidence model is Core-only).
export function parseSkills(raw: string | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const s = part.trim();
    if (s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
}

export function serializeSkills(skills: readonly string[]): string {
  return skills.join(', ');
}

export interface PrefillApplication {
  readonly state: IntakeState;
  readonly provenance: ProvenanceMap;
  readonly skills: string[];
  readonly skillsFromResume: boolean;
}

// Apply a résumé prefill onto a fresh/empty state. Only keys present in the
// prefill are populated, each tagged provenance 'resume'. Skills come from
// the free-text key_skills. (Applied once, on a clean intake — the recruiter
// then edits; edits flip provenance to 'edited' in the view.)
export function applyPrefill(
  base: IntakeState,
  prefill: TalentRecordPrefill,
): PrefillApplication {
  const state: IntakeState = { ...base };
  const provenance: ProvenanceMap = {};
  for (const key of PREFILL_TEXT_KEYS) {
    const v = (prefill as Record<string, unknown>)[key];
    if (typeof v === 'string' && v !== '') {
      (state as unknown as Record<string, string>)[key] = v;
      provenance[key] = 'resume';
    }
  }
  const skills = parseSkills(prefill.key_skills);
  return {
    state,
    provenance,
    skills,
    skillsFromResume: skills.length > 0,
  };
}

// Mark a field 'edited' if it previously came from the résumé. A field with
// no prior provenance (recruiter-entered) carries none.
export function provenanceAfterEdit(prev: Provenance | undefined): Provenance | undefined {
  if (prev === 'resume' || prev === 'edited') return 'edited';
  return undefined;
}

// Build the POST /v1/talent-records body. Required: first/last name.
// Optional strings omitted when empty (the BE treats absent as "not set").
export function buildCreateBody(
  state: IntakeState,
  skills: readonly string[],
): CreateTalentRecordRequest {
  const body: Record<string, unknown> = {
    first_name: state.first_name.trim(),
    last_name: state.last_name.trim(),
  };
  for (const key of INTAKE_TEXT_KEYS) {
    if (key === 'first_name' || key === 'last_name') continue;
    const v = state[key];
    if (typeof v === 'string' && v.trim() !== '') body[key] = v.trim();
  }
  const keySkills = serializeSkills(skills);
  if (keySkills !== '') body['key_skills'] = keySkills;
  if (state.can_relocate) body['can_relocate'] = true;
  if (state.is_hot) body['is_hot'] = true;
  return body as unknown as CreateTalentRecordRequest;
}
