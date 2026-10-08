import type {
  TalentRecordView,
  UpdateTalentRecordRequest,
  WorkHistoryDraft,
} from './types';

// The Add/Edit-Talent intake field model + the full-profile EDIT body builder.
//
// NOTE: the résumé-first CREATE helpers (applyPrefill, buildCreateBody) were
// removed with the synchronous draft-from-resume cutover. The durable async
// Talent Intake flow owns create-side mapping now: the FE maps the persisted
// review_payload ↔ the form in TalentCreateView, and promotion builds the
// canonical create input server-side (TalentIntakePromotionService). There is a
// single create-body authority; this module now only serves the EDIT path
// (stateFromTalent + buildPatchBody) and the shared field model.

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
  // NOT a structured skill picker.
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

// Full-profile EDIT — pre-fill the intake state from an existing record. Every
// IntakeState key maps 1:1 to a TalentRecordView field; nullable strings
// collapse to '' (the form's empty sentinel); the select fields collapse null →
// '' ("Not stated"). country is non-null on the record.
export function stateFromTalent(t: TalentRecordView): IntakeState {
  return {
    first_name: t.first_name,
    last_name: t.last_name,
    current_employer: t.current_employer ?? '',
    email1: t.email1 ?? '',
    email2: t.email2 ?? '',
    phone_cell: t.phone_cell ?? '',
    phone_home: t.phone_home ?? '',
    phone_work: t.phone_work ?? '',
    web_site: t.web_site ?? '',
    best_time_to_call: t.best_time_to_call ?? '',
    title: t.title ?? '',
    address: t.address ?? '',
    address2: t.address2 ?? '',
    city: t.city ?? '',
    state: t.state ?? '',
    zip: t.zip ?? '',
    country: t.country,
    availability_status: t.availability_status ?? '',
    engagement_type: t.engagement_type ?? '',
    work_authorization: t.work_authorization ?? '',
    date_available: t.date_available ?? '',
    current_pay: t.current_pay ?? '',
    desired_pay: t.desired_pay ?? '',
    source: t.source ?? '',
    notes: t.notes ?? '',
    key_skills: t.key_skills ?? '',
    can_relocate: t.can_relocate,
    is_hot: t.is_hot,
  };
}

// Build the PATCH /v1/talent-records/:id body for the full-profile edit. TRUE
// PATCH semantics (R4 omit-vs-null): omitted → unchanged; explicit null → cleared.
//   - email1 + phone_cell are NEVER sent — identity/dedup anchors, read-only.
//   - country is non-null: sent only when changed to a non-empty value.
//   - the select fields clear to null on ''.
//   - work_history: pass the reviewed set ONLY when the recruiter touched it
//     (replace-set). Omit it (undefined) when untouched so the BE leaves the
//     declared work-history alone (avoids needless row re-mint on every save).
export function buildPatchBody(
  state: IntakeState,
  initial: TalentRecordView,
  workHistory?: readonly WorkHistoryDraft[],
): UpdateTalentRecordRequest {
  const body: Record<string, unknown> = {};
  if (state.first_name.trim() !== initial.first_name) body['first_name'] = state.first_name.trim();
  if (state.last_name.trim() !== initial.last_name) body['last_name'] = state.last_name.trim();
  if (state.can_relocate !== initial.can_relocate) body['can_relocate'] = state.can_relocate;
  if (state.is_hot !== initial.is_hot) body['is_hot'] = state.is_hot;

  // country — non-null column; no clear-to-null. Send only a non-empty change.
  if (state.country.trim() !== '' && state.country.trim() !== initial.country) {
    body['country'] = state.country.trim();
  }

  // Nullable strings — '' → null (explicit clear); else send the change.
  // email1/phone_cell EXCLUDED (identity anchors, locked in the form).
  const initialAsRecord = initial as unknown as Record<string, unknown>;
  const nullable: ReadonlyArray<keyof IntakeState> = [
    'email2', 'phone_home', 'phone_work',
    'address', 'address2', 'city', 'state', 'zip',
    'source', 'key_skills', 'current_employer', 'current_pay',
    'desired_pay', 'date_available', 'notes', 'web_site',
    'best_time_to_call', 'title',
  ];
  for (const k of nullable) {
    const initVal = (initialAsRecord[k] as string | null) ?? '';
    const cur = state[k] as string;
    if (cur !== initVal) body[k] = cur === '' ? null : cur;
  }

  // Select fields (closed vocabularies) — '' → null (clears to "not stated").
  const selects: ReadonlyArray<keyof IntakeState> = [
    'availability_status', 'engagement_type', 'work_authorization',
  ];
  for (const k of selects) {
    const initVal = (initialAsRecord[k] as string | null) ?? '';
    const cur = state[k] as string;
    if (cur !== initVal) body[k] = cur === '' ? null : cur;
  }

  // Work-history replace-set — only when the recruiter edited it.
  if (workHistory !== undefined) {
    body['work_history'] = workHistory.filter(
      (e) => e.employer_name.trim() !== '' && e.role_title.trim() !== '',
    );
  }

  return body as unknown as UpdateTalentRecordRequest;
}
