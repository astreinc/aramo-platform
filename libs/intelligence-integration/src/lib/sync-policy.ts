import type { IntelligenceProfileReadResponse, ResolvedFactView } from '@aramo/intelligence-contracts';
import type { IntelligenceWritableColumn, SyncPolicyMode } from '@aramo/talent-record';

// ATI-SEP-1 T8 (ADR-0036 §3 "TI → ATS") — the per-tenant INBOUND field sync
// policy and the pure decision matrix the inbound sync applies.
//
// A field key groups one kind of Golden fact. Its mode, per tenant
// (talent_intelligence_sync_policy; a missing row = the default below):
//   AUTO_APPLY — write the TI value into the ATS field, but ONLY when the field
//                is empty or provably machine-sourced (never recruiter-confirmed);
//                anything else is routed to review instead.
//   REVIEW     — never write; record a TalentRecordReconcileContradiction
//                (source_kind INTELLIGENCE) + the field's PENDING_REVIEW summary.
//   IGNORE     — do nothing.
//
// Conservative defaults (PO direction): everything REVIEW, except availability
// (low-risk, time-sensitive) AUTO_APPLY and contacts IGNORE.
//
// AUTO_APPLY is honoured only where the ATS has a single scalar slot to fill.
// Work authorization (sensitive, TI-1G) and the typed evidence collections
// (work history, education, certifications, projects) have no automatic write
// path in v1: an AUTO_APPLY row for them is treated as REVIEW.

export const INTELLIGENCE_SYNC_FIELD_KEYS = [
  'name',
  'contacts',
  'current_employer',
  'title',
  'location',
  'public_profile_url',
  'availability',
  'work_authorization',
  'skills',
  'work_history',
  'education',
  'certifications',
  'projects',
] as const;
export type IntelligenceSyncFieldKey = (typeof INTELLIGENCE_SYNC_FIELD_KEYS)[number];

export const SYNC_POLICY_MODES = ['AUTO_APPLY', 'REVIEW', 'IGNORE'] as const satisfies readonly SyncPolicyMode[];

export const DEFAULT_INTELLIGENCE_SYNC_POLICY: Readonly<Record<IntelligenceSyncFieldKey, SyncPolicyMode>> = {
  name: 'REVIEW',
  contacts: 'IGNORE',
  current_employer: 'REVIEW',
  title: 'REVIEW',
  location: 'REVIEW',
  public_profile_url: 'REVIEW',
  availability: 'AUTO_APPLY',
  work_authorization: 'REVIEW',
  skills: 'REVIEW',
  work_history: 'REVIEW',
  education: 'REVIEW',
  certifications: 'REVIEW',
  projects: 'REVIEW',
};

/** Field keys with an automatic write path (a scalar ATS slot). */
export const AUTO_APPLY_CAPABLE: ReadonlySet<IntelligenceSyncFieldKey> = new Set<IntelligenceSyncFieldKey>([
  'name',
  'contacts',
  'current_employer',
  'title',
  'location',
  'public_profile_url',
  'availability',
  'skills',
]);

/** The TalentRecord column → field key (provenance rows are written per column). */
export const COLUMN_FIELD_KEY: Readonly<Record<IntelligenceWritableColumn, IntelligenceSyncFieldKey>> = {
  first_name: 'name',
  last_name: 'name',
  email1: 'contacts',
  phone_cell: 'contacts',
  city: 'location',
  state: 'location',
  country: 'location',
  current_employer: 'current_employer',
  title: 'title',
  web_site: 'public_profile_url',
  key_skills: 'skills',
  availability_status: 'availability',
  date_available: 'availability',
};

export function isSyncFieldKey(v: unknown): v is IntelligenceSyncFieldKey {
  return typeof v === 'string' && (INTELLIGENCE_SYNC_FIELD_KEYS as readonly string[]).includes(v);
}

/** The mode the inbound sync actually applies (stored row → default → capability clamp). */
export function effectiveMode(key: IntelligenceSyncFieldKey, stored?: SyncPolicyMode): SyncPolicyMode {
  const mode = stored ?? DEFAULT_INTELLIGENCE_SYNC_POLICY[key];
  return mode === 'AUTO_APPLY' && !AUTO_APPLY_CAPABLE.has(key) ? 'REVIEW' : mode;
}

/** Field keys whose current value TI supplied, from the INTELLIGENCE provenance column names. */
export function fieldKeysOfColumns(columns: Iterable<string>): Set<IntelligenceSyncFieldKey> {
  const out = new Set<IntelligenceSyncFieldKey>();
  for (const c of columns) {
    const k = (COLUMN_FIELD_KEY as Record<string, IntelligenceSyncFieldKey | undefined>)[c];
    if (k !== undefined) out.add(k);
    else if (isSyncFieldKey(c)) out.add(c);
  }
  return out;
}

// ── the decision matrix ─────────────────────────────────────────────────────

/** The recruiter's control on an ATS field (TalentProfileFieldState semantics). */
export interface FieldControl {
  value_state: 'UNKNOWN' | 'SET' | 'EXPLICITLY_CLEARED';
  source_type: 'MANUAL' | 'RESUME' | 'RECONCILED' | 'IMPORT';
  projection_policy: 'AUTO' | 'HOLD';
}

/**
 * Recruiter-confirmed = the recruiter authored it (MANUAL), froze it (HOLD) or
 * deliberately cleared it (EXPLICITLY_CLEARED). Such a value is NEVER overwritten.
 */
export function isRecruiterConfirmed(control: FieldControl | undefined): boolean {
  if (control === undefined) return false;
  return control.source_type === 'MANUAL' || control.projection_policy === 'HOLD' || control.value_state === 'EXPLICITLY_CLEARED';
}

/** Provably machine-sourced: a non-recruiter source, SET, still automatic. */
export function isMachineSourced(control: FieldControl | undefined): boolean {
  if (control === undefined) return false;
  return control.source_type !== 'MANUAL' && control.projection_policy === 'AUTO' && control.value_state === 'SET';
}

export type FieldDecision = 'APPLY' | 'REVIEW' | 'IGNORE';

/**
 * AUTO_APPLY writes only into an EMPTY field that is not recruiter-confirmed, or
 * over a value the field state proves machine-sourced. A non-empty value with no
 * control row is treated as recruiter-entered (the conservative reading): review.
 */
export function decideField(input: {
  mode: SyncPolicyMode;
  ats_empty: boolean;
  controls: ReadonlyArray<FieldControl | undefined>;
  writable: boolean;
}): FieldDecision {
  if (input.mode === 'IGNORE') return 'IGNORE';
  if (input.mode === 'REVIEW' || !input.writable) return 'REVIEW';
  if (input.controls.some(isRecruiterConfirmed)) return 'REVIEW';
  if (input.ats_empty) return 'APPLY';
  const known = input.controls.filter((c): c is FieldControl => c !== undefined);
  return known.length > 0 && known.every(isMachineSourced) ? 'APPLY' : 'REVIEW';
}

// ── proposals: TI facts that differ from the ATS ────────────────────────────

export interface AtsCurrentState {
  values: Partial<Record<IntelligenceWritableColumn, string | Date | null>>;
  email2: string | null;
  phones: string[];
  work_authorization: string | null;
  skill_names: string[];
  employer_names: string[];
  institution_names: string[];
  certification_names: string[];
  project_names: string[];
}

export interface FieldProposal {
  field_key: IntelligenceSyncFieldKey;
  /** The ATS field name the review / provenance rows are keyed on. */
  field_name: string;
  /** What an AUTO_APPLY writes (empty for a review-only proposal). */
  columns: Partial<Record<IntelligenceWritableColumn, string | Date>>;
  /** A short display string of the proposed value (for the reviewer). */
  display: string;
  /** True when every target column is currently empty. */
  ats_empty: boolean;
}

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : '');
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const empty = (v: string | Date | null | undefined): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim().length === 0);

const AVAILABILITY_TO_ATS: Readonly<Record<string, string>> = {
  AVAILABLE: 'available_now',
  OPEN_TO_OPPORTUNITIES: 'open_to_offers',
  NOT_AVAILABLE: 'not_looking',
};

const WORK_AUTH_TO_ATS: Readonly<Record<string, string>> = {
  PERMANENT_RESIDENT: 'PERMANENT_RESIDENT',
  REQUIRES_SPONSORSHIP: 'REQUIRES_SPONSORSHIP',
};

function partialDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return null;
  const [y, m = '01', d = '01'] = v.split('-');
  const date = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolved(profile: IntelligenceProfileReadResponse, type: ResolvedFactView['fact_type']): ResolvedFactView[] {
  return profile.facts.filter((f) => f.fact_type === type && f.state === 'RESOLVED');
}

function newNames(facts: ResolvedFactView[], key: string, present: string[]): string[] {
  const have = new Set(present.map(norm));
  const out: string[] = [];
  for (const f of facts) {
    const n = str(f.value[key]);
    if (n !== null && !have.has(norm(n)) && !out.some((o) => norm(o) === norm(n))) out.push(n);
  }
  return out;
}

/**
 * Every RESOLVED Golden fact that DIFFERS from what the ATS already holds, as a
 * per-field proposal. Contradicted or stale facts are never proposed. A fact
 * equal to the ATS value is no change (in tenant-scoped mode TI mostly returns
 * the tenant's own assertions — those produce nothing).
 */
export function proposalsFromProfile(profile: IntelligenceProfileReadResponse, ats: AtsCurrentState): FieldProposal[] {
  const out: FieldProposal[] = [];
  const v = ats.values;

  const name = resolved(profile, 'NAME')[0];
  if (name !== undefined) {
    const first = str(name.value['first']);
    const last = str(name.value['last']);
    const columns: FieldProposal['columns'] = {};
    if (first !== null && norm(first) !== norm(v.first_name)) columns.first_name = first;
    if (last !== null && norm(last) !== norm(v.last_name)) columns.last_name = last;
    if (Object.keys(columns).length > 0) {
      out.push({ field_key: 'name', field_name: 'first_name', columns, display: [first, last].filter(Boolean).join(' '), ats_empty: empty(v.first_name) && empty(v.last_name) });
    }
  }

  const emails = resolved(profile, 'EMAIL')
    .map((f) => str(f.value['value']))
    .filter((e): e is string => e !== null && norm(e) !== norm(v.email1) && norm(e) !== norm(ats.email2));
  if (emails[0] !== undefined) {
    out.push({ field_key: 'contacts', field_name: 'email1', columns: { email1: emails[0] }, display: emails[0], ats_empty: empty(v.email1) });
  }
  const digits = (p: string) => p.replace(/\D/g, '');
  const knownPhones = new Set(ats.phones.map(digits));
  const phones = resolved(profile, 'PHONE')
    .map((f) => str(f.value['value']))
    .filter((p): p is string => p !== null && !knownPhones.has(digits(p)));
  if (phones[0] !== undefined) {
    out.push({ field_key: 'contacts', field_name: 'phone_cell', columns: { phone_cell: phones[0] }, display: phones[0], ats_empty: empty(v.phone_cell) });
  }

  const employer = str(resolved(profile, 'CURRENT_EMPLOYER')[0]?.value['name']);
  if (employer !== null && norm(employer) !== norm(v.current_employer)) {
    out.push({ field_key: 'current_employer', field_name: 'current_employer', columns: { current_employer: employer }, display: employer, ats_empty: empty(v.current_employer) });
  }

  const title = str(resolved(profile, 'TITLE')[0]?.value['value']);
  if (title !== null && norm(title) !== norm(v.title)) {
    out.push({ field_key: 'title', field_name: 'title', columns: { title }, display: title, ats_empty: empty(v.title) });
  }

  const loc = resolved(profile, 'LOCATION')[0];
  if (loc !== undefined) {
    const city = str(loc.value['city']);
    const region = str(loc.value['region']);
    const country = str(loc.value['country']);
    const differs = (city !== null && norm(city) !== norm(v.city)) || (region !== null && norm(region) !== norm(v.state));
    if (differs) {
      const columns: FieldProposal['columns'] = {
        ...(city !== null ? { city } : {}),
        ...(region !== null ? { state: region } : {}),
        ...(country !== null && country.length <= 100 ? { country } : {}),
      };
      out.push({ field_key: 'location', field_name: 'city', columns, display: [city, region, country].filter(Boolean).join(', '), ats_empty: empty(v.city) && empty(v.state) });
    }
  }

  const url = str(resolved(profile, 'PUBLIC_PROFILE_URL')[0]?.value['url']);
  if (url !== null && norm(url) !== norm(v.web_site)) {
    out.push({ field_key: 'public_profile_url', field_name: 'web_site', columns: { web_site: url }, display: url, ats_empty: empty(v.web_site) });
  }

  const avail = resolved(profile, 'AVAILABILITY')[0];
  if (avail !== undefined) {
    const status = AVAILABILITY_TO_ATS[String(avail.value['status'])];
    const date = partialDate(avail.value['date_available']);
    const currentDate = v.date_available instanceof Date ? v.date_available.toISOString().slice(0, 10) : null;
    const statusDiffers = status !== undefined && status !== v.availability_status;
    const dateDiffers = date !== null && date.toISOString().slice(0, 10) !== currentDate;
    if (statusDiffers || dateDiffers) {
      const columns: FieldProposal['columns'] = { ...(status !== undefined ? { availability_status: status } : {}), ...(date !== null ? { date_available: date } : {}) };
      out.push({
        field_key: 'availability',
        field_name: 'availability_status',
        columns,
        display: [status, date?.toISOString().slice(0, 10)].filter(Boolean).join(' · '),
        ats_empty: (empty(v.availability_status) || v.availability_status === 'unknown') && v.date_available == null,
      });
    }
  }

  const wa = resolved(profile, 'WORK_AUTHORIZATION')[0];
  if (wa !== undefined) {
    const status = String(wa.value['status'] ?? '');
    const jurisdiction = str(wa.value['jurisdiction']);
    const atsEquivalent = status === 'CITIZEN' && (jurisdiction === null || jurisdiction.toUpperCase() === 'US') ? 'US_CITIZEN' : WORK_AUTH_TO_ATS[status];
    if (status.length > 0 && atsEquivalent !== ats.work_authorization) {
      out.push({ field_key: 'work_authorization', field_name: 'work_authorization', columns: {}, display: [status, jurisdiction].filter(Boolean).join(' · '), ats_empty: ats.work_authorization === null });
    }
  }

  const keySkills = typeof v.key_skills === 'string' ? v.key_skills.split(/[,;\n]/) : [];
  const skills = newNames(resolved(profile, 'SKILL'), 'name', [...ats.skill_names, ...keySkills]);
  if (skills.length > 0) {
    const joined = skills.slice(0, 50).join(', ');
    out.push({ field_key: 'skills', field_name: 'key_skills', columns: { key_skills: joined }, display: joined, ats_empty: empty(v.key_skills) });
  }

  const collections: Array<[IntelligenceSyncFieldKey, ResolvedFactView['fact_type'], string, string[]]> = [
    ['work_history', 'WORK_HISTORY', 'employer', ats.employer_names],
    ['education', 'EDUCATION', 'institution', ats.institution_names],
    ['certifications', 'CERTIFICATION', 'name', ats.certification_names],
    ['projects', 'PROJECT', 'name', ats.project_names],
  ];
  for (const [key, type, prop, present] of collections) {
    const names = newNames(resolved(profile, type), prop, present);
    if (names.length > 0) {
      out.push({ field_key: key, field_name: key, columns: {}, display: names.slice(0, 50).join(', '), ats_empty: present.length === 0 });
    }
  }
  return out;
}
