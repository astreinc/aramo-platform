import type { SourcedTalentRow } from '@aramo/sourced-talent';

// ATI-SEP-1 T10 WP2 — the display/contact material of a sourced arrival, read
// purely from the ATS-local sourced_talent row (A2 F-1: sourcing runs on ATS
// data). Every channel writer lands the arrival's parsed applicant fields in
// `provenance` (raw, immutable) and the normalized email/phone in the dedicated
// columns:
//   * manual capture  → provenance.structured.{first_name,last_name,email,phone,
//                        profile_url,current_employer}
//   * Indeed apply    → provenance.applicant.{full_name,email,phone}
//   * canonicalize    → provenance.applicant.{full_name,email,profile_url}
// Nothing here reads a trust ledger or an Intelligence projection.

export interface SourcedArrivalDescription {
  display_name: string | null;
  // The two-part name a TalentRecord requires (null when either part is missing).
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  headline: string | null;
  profile_url: string | null;
  // The ingestion RawPayloadReference this arrival was landed from (the legal-
  // basis source for promotion), or null when the writer recorded none.
  ingestion_payload_id: string | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length === 0 ? null : t;
}

// "Ada King Lovelace" → first "Ada", last "King Lovelace". A single token is not
// a two-part name (null last) — promotion defers rather than inventing a part.
export function splitFullName(full: string | null): { first: string | null; last: string | null } {
  if (full === null) return { first: null, last: null };
  const parts = full.split(' ');
  if (parts.length < 2) return { first: parts[0] ?? null, last: null };
  return { first: parts[0] ?? null, last: parts.slice(1).join(' ') };
}

export function describeSourcedArrival(row: SourcedTalentRow): SourcedArrivalDescription {
  const p = obj(row.provenance);
  const structured = obj(p['structured']);
  const applicant = obj(p['applicant']);

  let first = str(structured['first_name']);
  let last = str(structured['last_name']);
  const fullName = str(applicant['full_name']);
  if (first === null && last === null && fullName !== null) {
    const split = splitFullName(fullName);
    first = split.first;
    last = split.last;
  }
  const display =
    [first, last].filter((x): x is string => x !== null).join(' ').trim() || fullName || null;

  const email =
    row.normalized_email ?? str(structured['email']) ?? str(applicant['email']);
  const phone =
    str(structured['phone']) ?? str(applicant['phone']) ?? row.normalized_phone ?? null;

  return {
    display_name: display === '' ? null : display,
    first_name: first,
    last_name: last,
    email: email === null ? null : email.toLowerCase(),
    phone,
    headline: str(structured['current_employer']),
    profile_url: str(structured['profile_url']) ?? str(applicant['profile_url']),
    ingestion_payload_id: str(p['ingestion_payload_id']),
  };
}
