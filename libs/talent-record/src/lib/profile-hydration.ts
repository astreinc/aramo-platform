import type {
  ProfileHydrationItem,
  ProfileHydrationResponse,
  ProfileHydrationValue,
} from './dto/profile-hydration.view.js';
import type {
  TalentProfileFieldStateReadRow,
  TalentProfileValueState,
} from './talent-record-reconcile.repository.js';

// TALENT-INTEL-1 TI-1E-A — the pure composition behind the aggregate
// profile-hydration projection. No I/O: it takes the operational record + the
// TI-1D-B field-state read model and derives the display projection. Extraction,
// reconciliation, and evidence writes are OUT of scope here by construction.

type FieldValueType = 'string' | 'boolean';

interface ProfileHydrationFieldSpec {
  readonly field_key: string;
  readonly type: FieldValueType;
}

// The COMPLETE governed editable field set (the scalar profile columns the
// create/edit surfaces hydrate — from UpdateTalentRecordRequestDto, excluding
// the non-scalar work_history / field_controls). Booleans typed so they are
// never stringified. This is the single enumeration the projection covers;
// operational-only fields (no field-state/evidence writer) are included and
// returned HONESTLY (source_type null), never given fabricated provenance.
export const PROFILE_HYDRATION_FIELDS: readonly ProfileHydrationFieldSpec[] = [
  { field_key: 'first_name', type: 'string' },
  { field_key: 'last_name', type: 'string' },
  { field_key: 'email1', type: 'string' },
  { field_key: 'email2', type: 'string' },
  { field_key: 'phone_home', type: 'string' },
  { field_key: 'phone_cell', type: 'string' },
  { field_key: 'phone_work', type: 'string' },
  { field_key: 'address', type: 'string' },
  { field_key: 'address2', type: 'string' },
  { field_key: 'city', type: 'string' },
  { field_key: 'state', type: 'string' },
  { field_key: 'zip', type: 'string' },
  { field_key: 'country', type: 'string' },
  { field_key: 'source', type: 'string' },
  { field_key: 'key_skills', type: 'string' },
  { field_key: 'current_employer', type: 'string' },
  { field_key: 'current_pay', type: 'string' },
  { field_key: 'desired_pay', type: 'string' },
  { field_key: 'date_available', type: 'string' },
  { field_key: 'can_relocate', type: 'boolean' },
  { field_key: 'is_hot', type: 'boolean' },
  { field_key: 'notes', type: 'string' },
  { field_key: 'web_site', type: 'string' },
  { field_key: 'best_time_to_call', type: 'string' },
  { field_key: 'title', type: 'string' },
  { field_key: 'availability_status', type: 'string' },
  { field_key: 'engagement_type', type: 'string' },
  { field_key: 'work_authorization', type: 'string' },
  { field_key: 'owner_id', type: 'string' },
] as const;

// The record columns the projection reads (a subset of TalentRecord).
export interface ProfileHydrationInputRecord {
  first_name: string | null;
  last_name: string | null;
  email1: string | null;
  email2: string | null;
  phone_home: string | null;
  phone_cell: string | null;
  phone_work: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  source: string | null;
  key_skills: string | null;
  current_employer: string | null;
  current_pay: string | null;
  desired_pay: string | null;
  date_available: string | null;
  can_relocate: boolean;
  is_hot: boolean;
  notes: string | null;
  web_site: string | null;
  best_time_to_call: string | null;
  title: string | null;
  availability_status: string | null;
  engagement_type: string | null;
  work_authorization: string | null;
  owner_id: string | null;
}

function typeValue(raw: unknown, type: FieldValueType): ProfileHydrationValue {
  if (type === 'boolean') return raw === true; // non-null boolean column
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

// Server-owned precedence (ruling A): explicitly-governed clear → governed SET
// control → present operational value → UNKNOWN. Explicit governance (a control
// row that is SET or EXPLICITLY_CLEARED) is honored verbatim; only in its
// absence is the DISPLAY state derived from value presence (so a reconciled or
// plain operational value shows as SET, not UNKNOWN, while UNKNOWN stays UNKNOWN
// for a genuinely empty, ungoverned field).
function deriveValueState(
  fs: TalentProfileFieldStateReadRow | undefined,
  currentValue: ProfileHydrationValue,
  type: FieldValueType,
): TalentProfileValueState {
  if (fs?.value_state === 'EXPLICITLY_CLEARED') return 'EXPLICITLY_CLEARED';
  if (fs?.value_state === 'SET') return 'SET';
  if (type === 'boolean') return 'SET'; // a non-null boolean is always a value
  const present =
    typeof currentValue === 'string' ? currentValue.trim() !== '' : currentValue !== null;
  return present ? 'SET' : 'UNKNOWN';
}

export function composeProfileHydration(
  talentRecordId: string,
  record: ProfileHydrationInputRecord,
  fieldStateRows: readonly TalentProfileFieldStateReadRow[],
): ProfileHydrationResponse {
  const byKey = new Map(fieldStateRows.map((r) => [r.field_key, r]));
  const rec = record as unknown as Record<string, unknown>;

  const fields: ProfileHydrationItem[] = PROFILE_HYDRATION_FIELDS.map((spec) => {
    const fs = byKey.get(spec.field_key);
    const current_value = typeValue(rec[spec.field_key], spec.type);
    return {
      field_key: spec.field_key,
      current_value,
      value_state: deriveValueState(fs, current_value, spec.type),
      // No fabrication: for a field with no field-state row these stay
      // null / AUTO / null / NONE — a plain operational value, honestly reported.
      source_type: fs?.source_type ?? null,
      projection_policy: fs?.projection_policy ?? 'AUTO',
      provenance: fs?.provenance ?? null,
      resolution_status: fs?.resolution_status ?? 'NONE',
      resolution_reason: fs?.resolution_reason ?? null,
      proposed_value: fs?.proposed_value ?? null,
    };
  }).sort((a, b) => a.field_key.localeCompare(b.field_key));

  return { talent_record_id: talentRecordId, fields };
}
