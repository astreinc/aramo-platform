// TR-4 B2 (DDR §3.1) — the PURE mapper: a typed talent_evidence row → the
// canonical CLAIMS payload the T4-B1 registry accepts. The mapper's OUTPUT
// ALWAYS conforms (property-tested in ledger-mapper.spec.ts): employer_name and
// role_title are NOT-NULL columns, so EMPLOYMENT always has its required fields;
// surface_form is NOT-NULL, so SKILL always has value_raw. The T4-B1 write gate
// therefore never fires on this path — a property, not an assumption.
//
// Dates: the typed store already holds parsed `@db.Date` values, so there is no
// unparseable-string case here — a Date formats to an ISO calendar string
// (YYYY-MM-DD); a null column omits the raw (the gate then yields null). The raw
// LLM date string was consumed at extraction time; the ISO of the stored Date is
// the honest raw available to the reconcile (no data destroyed beyond extraction).
//
// skill_id is DERIVED by the gate from value_raw (deriveSkillIdCanonical) — the
// same namespace as the producer's deriveSkillId (B1 parity), so the ledger
// skill_id is byte-identical to the typed row's skill_id.

export interface LedgerClaim {
  assertion_type: 'EMPLOYMENT' | 'SKILL' | 'DEGREE' | 'CERTIFICATION';
  // The recordEvidence input payload; the write gate canonicalizes it (adds
  // employer_norm / ISO dates / skill_id, preserves raw).
  payload: Record<string, unknown>;
  // Stable provenance key: the talent_evidence row id backs the ledger's
  // source_ref and the idempotence existence check (source_ref → the typed row).
  source_ref: {
    talent_evidence_id: string;
    kind: 'work_history' | 'skill' | 'education' | 'certification';
    store: 'talent_evidence';
  };
}

function toIsoDate(d: Date): string {
  // Calendar-date slice of the ISO string; the stored column is @db.Date (no time).
  return d.toISOString().slice(0, 10);
}

export function mapWorkHistoryToClaim(row: {
  id: string;
  employer_name: string;
  role_title: string;
  start_date: Date | null;
  end_date: Date | null;
  employment_type: string | null;
}): LedgerClaim {
  const payload: Record<string, unknown> = {
    employer_raw: row.employer_name,
    role_title_raw: row.role_title,
  };
  if (row.start_date !== null) payload['start_date_raw'] = toIsoDate(row.start_date);
  if (row.end_date !== null) payload['end_date_raw'] = toIsoDate(row.end_date);
  if (row.employment_type !== null && row.employment_type.trim() !== '') {
    payload['employment_type_raw'] = row.employment_type;
  }
  return {
    assertion_type: 'EMPLOYMENT',
    payload,
    source_ref: { talent_evidence_id: row.id, kind: 'work_history', store: 'talent_evidence' },
  };
}

export function mapSkillToClaim(row: {
  id: string;
  surface_form: string;
  skill_id: string;
}): LedgerClaim {
  // Only value_raw is passed; the gate re-derives skill_id (parity guarantees it
  // equals row.skill_id).
  return {
    assertion_type: 'SKILL',
    payload: { value_raw: row.surface_form },
    source_ref: { talent_evidence_id: row.id, kind: 'skill', store: 'talent_evidence' },
  };
}

// TR-7 B1 — DEGREE mapper. institution_name + degree_name are NOT-NULL columns, so
// the DEGREE shape's required fields (institution_raw, degree_raw) are ALWAYS
// present → the write gate never fires on this path (conformance property).
// conferred_date is a stored @db.Date → its ISO is the honest raw for the gate.
export function mapEducationToClaim(row: {
  id: string;
  institution_name: string;
  degree_name: string;
  field_of_study: string | null;
  conferred_date: Date | null;
}): LedgerClaim {
  const payload: Record<string, unknown> = {
    institution_raw: row.institution_name,
    degree_raw: row.degree_name,
  };
  if (row.field_of_study !== null && row.field_of_study.trim() !== '') {
    payload['field_raw'] = row.field_of_study;
  }
  if (row.conferred_date !== null) payload['conferred_date_raw'] = toIsoDate(row.conferred_date);
  return {
    assertion_type: 'DEGREE',
    payload,
    source_ref: { talent_evidence_id: row.id, kind: 'education', store: 'talent_evidence' },
  };
}

// TR-7 B1 — CERTIFICATION mapper. certification_name is NOT-NULL → name_raw always
// present (conformance property). issuer/credential and the two dates are optional.
export function mapCertificationToClaim(row: {
  id: string;
  certification_name: string;
  issuer_name: string | null;
  credential_ref: string | null;
  issued_date: Date | null;
  expiry_date: Date | null;
}): LedgerClaim {
  const payload: Record<string, unknown> = { name_raw: row.certification_name };
  if (row.issuer_name !== null && row.issuer_name.trim() !== '') {
    payload['issuer_raw'] = row.issuer_name;
  }
  if (row.credential_ref !== null && row.credential_ref.trim() !== '') {
    payload['credential_ref_raw'] = row.credential_ref;
  }
  if (row.issued_date !== null) payload['issued_date_raw'] = toIsoDate(row.issued_date);
  if (row.expiry_date !== null) payload['expiry_date_raw'] = toIsoDate(row.expiry_date);
  return {
    assertion_type: 'CERTIFICATION',
    payload,
    source_ref: { talent_evidence_id: row.id, kind: 'certification', store: 'talent_evidence' },
  };
}
