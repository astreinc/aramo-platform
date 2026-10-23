import {
  SOURCE_SYSTEM_ARAMO_ATS,
  validateTalentIngestRequest,
  type AvailabilityStatus,
  type IdentityEmail,
  type IdentityPhone,
  type IngestSourceKind,
  type IngestValidationIssue,
  type TalentIngestAssertion,
  type TalentIngestRequest,
  type WorkAuthorizationStatus,
} from '@aramo/intelligence-contracts';
import type { IntelligenceEvidenceSnapshot } from '@aramo/talent-evidence';
import { selectCurrentWorkAuthorization } from '@aramo/talent-evidence';
import type { AdmissibleTalentRecord } from '@aramo/talent-record';

import { INTELLIGENCE_SYNC_FIELD_KEYS, type IntelligenceSyncFieldKey } from './sync-policy.js';

// ATI-SEP-1 T8 (ADR-0036 §4) — builds the CLOSED admission payload
// (POST /v1/ingest/talent) from COMMITTED ATS data, per the
// @aramo/intelligence-contracts admission catalogue:
//
//   Class A — skills, work history (incl. persisted experience assertions as
//             accomplishments), education, certifications, projects, current
//             employer, title, professional location (city / region / country),
//             public profile URL (web_site), availability.
//   Class B — names, emails, phones (identity block), work authorization
//             (current state, TI-1G selection).
//   NEVER    — notes, pay, source, is_hot, address / address2 / zip, rate
//             expectations, requisition / pipeline / submittal / interview data,
//             document bytes / ids / keys / URLs. The inputs cannot carry them:
//             AdmissibleTalentRecord and IntelligenceEvidenceSnapshot are
//             explicit column allowlists. Provenance carries ONLY an opaque
//             source_document_hash (D-7).
//
// Verification: the ATS holds no verified identifier signal of its own (the
// legacy trust anchors are retired, T10), so every email / phone is sent
// UNVERIFIED — TI's own OTP verification is the only VERIFIED path.
//
// Source kinds: an entry derived from a résumé (résumé text hash present, or a
// résumé / derived source label) is RESUME_DERIVED + ai_derived (the LLM
// structured it) — for work authorization that makes it NON-AUTHORITATIVE per
// TI-1G (TI recomputes this itself; isAuthoritativeWorkAuthorization).
// Everything else is RECRUITER-entered.
//
// Fields whose CURRENT ATS value came FROM Talent Intelligence (provenance
// source_kind INTELLIGENCE, applied by the inbound sync) are NOT sent back:
// echoing TI's value as ATS evidence would self-corroborate.
//
// Each built item is admitted individually through the contracts validator
// (an entry the validator would refuse — e.g. a URL inside an accomplishment —
// is DROPPED, never sent); the assembled request is then validated again as a
// whole and the build FAILS CLOSED if anything is still refused.

export interface BuildIngestInput {
  /** The outbox event id — TI's idempotency key. */
  source_event_id: string;
  occurred_at: string;
  record: AdmissibleTalentRecord;
  evidence: IntelligenceEvidenceSnapshot;
  /** Sync-policy field keys whose current value TI supplied (never echoed). */
  intelligence_sourced_fields?: ReadonlySet<string>;
  now?: Date;
}

export interface BuildIngestResult {
  request: TalentIngestRequest;
  /** Built items dropped because the admission validator refused them (paths only). */
  dropped: Array<{ path: string; code: IngestValidationIssue['code'] }>;
}

export class IngestPayloadRejectedError extends Error {
  constructor(readonly issues: Array<{ path: string; code: string }>) {
    super(`intelligence ingest payload failed the admission validator (${issues.length} issue(s))`);
    this.name = 'IngestPayloadRejectedError';
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function iso(d: Date): string {
  return d.toISOString();
}

/** YYYY-MM-DD from a @db.Date column (UTC). */
function day(d: Date | null): string | undefined {
  return d === null ? undefined : d.toISOString().slice(0, 10);
}

/** YYYY-MM partial date. */
function month(d: Date | null): string | undefined {
  return d === null ? undefined : d.toISOString().slice(0, 7);
}

function text(v: string | null | undefined, max: number): string | undefined {
  if (v === null || v === undefined) return undefined;
  const t = v.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

// Free text never carries a link: a statement / summary containing a URL, a
// storage URI, a data URI or a presigned-URL marker is dropped whole (it could
// point at a document). Public profile URLs travel only as PUBLIC_PROFILE_URL.
const EMBEDDED_LINK = /(?:\b(?:https?|s3|gs|ftp|file|az|wasbs?|abfss?):\/\/)|(?:\bdata:[a-z]+\/)|x-amz-|x-goog-|www\./i;

function freeText(v: string | null | undefined, max: number): string | undefined {
  const t = text(v, max);
  return t !== undefined && EMBEDDED_LINK.test(t) ? undefined : t;
}

function provenance(hash: string | null): { provenance?: { source_document_hash: string } } {
  return hash !== null && SHA256_HEX.test(hash) ? { provenance: { source_document_hash: hash } } : {};
}

function sourceOf(resumeDerived: boolean): { source_kind: IngestSourceKind; ai_derived: boolean } {
  return resumeDerived ? { source_kind: 'RESUME_DERIVED', ai_derived: true } : { source_kind: 'RECRUITER', ai_derived: false };
}

const AVAILABILITY: Readonly<Record<string, AvailabilityStatus>> = {
  available_now: 'AVAILABLE',
  open_to_offers: 'OPEN_TO_OPPORTUNITIES',
  not_looking: 'NOT_AVAILABLE',
};

/** ATS work-authorization vocabulary → the contracts vocabulary (NOT_DISCLOSED → nothing). */
export function mapWorkAuthorization(status: string, requiresSponsorship: boolean): WorkAuthorizationStatus | null {
  switch (status) {
    case 'US_CITIZEN':
      return 'CITIZEN';
    case 'PERMANENT_RESIDENT':
      return 'PERMANENT_RESIDENT';
    case 'VISA_HOLDER':
      return requiresSponsorship ? 'REQUIRES_SPONSORSHIP' : 'AUTHORIZED';
    case 'REQUIRES_SPONSORSHIP':
      return 'REQUIRES_SPONSORSHIP';
    case 'OTHER':
      return 'UNKNOWN';
    default:
      return null;
  }
}

function accomplishmentsOf(assertions: unknown): string[] {
  if (!Array.isArray(assertions)) return [];
  const out: string[] = [];
  for (const a of assertions) {
    if (a === null || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const statement = typeof r['statement'] === 'string' ? r['statement'].trim() : '';
    if (EMBEDDED_LINK.test(statement)) continue;
    const type = typeof r['type'] === 'string' ? r['type'].trim() : '';
    if (statement.length === 0 || type.length === 0) continue;
    out.push(statement.slice(0, 4000));
    if (out.length >= 50) break;
  }
  return out;
}

function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

function phoneDigits(v: string): string {
  return v.replace(/\D/g, '');
}

const isSyncKey = (k: string): k is IntelligenceSyncFieldKey => (INTELLIGENCE_SYNC_FIELD_KEYS as readonly string[]).includes(k);

/** Build + admit + validate. Throws IngestPayloadRejectedError when the assembled request is refused. */
export function buildTalentIngestRequest(input: BuildIngestInput): BuildIngestResult {
  const { record, evidence } = input;
  const now = input.now ?? new Date();
  const skip = new Set([...(input.intelligence_sourced_fields ?? [])].filter(isSyncKey));
  const recordObserved = iso(record.updated_at);

  // ── identity (Class B) ────────────────────────────────────────────────────
  const emails: IdentityEmail[] = [];
  const phones: IdentityPhone[] = [];
  if (!skip.has('contacts')) {
    const seenEmail = new Set<string>();
    for (const [value, primary] of [
      [record.email1, true],
      [record.email2, false],
    ] as const) {
      const v = text(value, 320);
      if (v === undefined) continue;
      const key = normalizeEmail(v);
      if (seenEmail.has(key)) continue;
      seenEmail.add(key);
      emails.push({ value: v, is_primary: primary, verification: { status: 'UNVERIFIED' } });
    }
    const seenPhone = new Set<string>();
    for (const [value, primary] of [
      [record.phone_cell, true],
      [record.phone_home, false],
      [record.phone_work, false],
    ] as const) {
      const v = text(value, 40);
      if (v === undefined) continue;
      const key = phoneDigits(v);
      if (key.length === 0 || seenPhone.has(key)) continue;
      seenPhone.add(key);
      phones.push({ value: v, is_primary: primary, verification: { status: 'UNVERIFIED' } });
    }
  }
  const names: { first?: string; last?: string } = {};
  if (!skip.has('name')) {
    const first = text(record.first_name, 200);
    const last = text(record.last_name, 200);
    if (first !== undefined) names.first = first;
    if (last !== undefined) names.last = last;
  }

  // ── assertions ────────────────────────────────────────────────────────────
  const pendingAssertions: TalentIngestAssertion[] = [];
  const recruiter = { source_kind: 'RECRUITER' as const, ai_derived: false, observed_at: recordObserved };

  const employer = text(record.current_employer, 300);
  if (employer !== undefined && !skip.has('current_employer')) {
    pendingAssertions.push({ assertion_type: 'CURRENT_EMPLOYER', payload: { name: employer }, ...recruiter });
  }
  const title = text(record.title, 300);
  if (title !== undefined && !skip.has('title')) {
    pendingAssertions.push({ assertion_type: 'TITLE', payload: { value: title }, ...recruiter });
  }
  const city = text(record.city, 200);
  const region = text(record.state, 200);
  // Country alone is the column default ('US'), not evidence: a location needs a city or region.
  if ((city !== undefined || region !== undefined) && !skip.has('location')) {
    const country = text(record.country, 100);
    pendingAssertions.push({
      assertion_type: 'LOCATION',
      payload: { ...(city ? { city } : {}), ...(region ? { region } : {}), ...(country ? { country } : {}) },
      ...recruiter,
    });
  }
  const webSite = text(record.web_site, 2048);
  if (webSite !== undefined && !skip.has('public_profile_url')) {
    pendingAssertions.push({ assertion_type: 'PUBLIC_PROFILE_URL', payload: { url: webSite }, ...recruiter });
  }
  const availability = record.availability_status !== null ? AVAILABILITY[record.availability_status] : undefined;
  if (availability !== undefined && !skip.has('availability')) {
    const dateAvailable = day(record.date_available);
    pendingAssertions.push({
      assertion_type: 'AVAILABILITY',
      payload: { status: availability, ...(dateAvailable ? { date_available: dateAvailable } : {}) },
      ...recruiter,
    });
  }

  // Work authorization — the TI-1G CURRENT state over the typed history, else the
  // talent-stated TalentRecord column. Never inferred from a résumé (TI-1G), so
  // RECRUITER; TI still decides authority itself.
  if (!skip.has('work_authorization')) {
    const current = selectCurrentWorkAuthorization(evidence.work_authorizations, now);
    if (current !== null) {
      const status = mapWorkAuthorization(current.work_authorization_status, current.requires_sponsorship);
      const jurisdiction = text(current.authorized_to_work_in[0], 64);
      if (status !== null) {
        pendingAssertions.push({
          assertion_type: 'WORK_AUTHORIZATION',
          payload: { status, ...(jurisdiction ? { jurisdiction } : status === 'CITIZEN' ? { jurisdiction: 'US' } : {}) },
          source_kind: 'RECRUITER',
          ai_derived: false,
          observed_at: iso(current.asserted_at),
          ...(current.effective_from ? { valid_from: day(current.effective_from) as string } : {}),
          ...(current.effective_to ? { valid_to: day(current.effective_to) as string } : {}),
        });
      }
    } else if (record.work_authorization !== null) {
      const status = mapWorkAuthorization(record.work_authorization, record.work_authorization === 'REQUIRES_SPONSORSHIP');
      if (status !== null) {
        pendingAssertions.push({
          assertion_type: 'WORK_AUTHORIZATION',
          payload: { status, ...(status === 'CITIZEN' ? { jurisdiction: 'US' } : {}) },
          ...recruiter,
        });
      }
    }
  }

  if (!skip.has('skills')) {
    const seen = new Set<string>();
    for (const s of evidence.skills) {
      const name = text(s.surface_form, 200);
      if (name === undefined || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const years = s.years_claimed !== null && s.years_claimed >= 0 && s.years_claimed <= 80 ? s.years_claimed : undefined;
      const proficiency = text(s.proficiency_claim, 64);
      const lastUsed = month(s.usage_end);
      pendingAssertions.push({
        assertion_type: 'SKILL',
        payload: { name, ...(years !== undefined ? { years } : {}), ...(lastUsed ? { last_used: lastUsed } : {}), ...(proficiency ? { proficiency } : {}) },
        ...sourceOf(s.resume_text_hash !== null || s.source === 'derived'),
        observed_at: iso(s.created_at),
        ...provenance(s.resume_text_hash),
      });
    }
  }

  if (!skip.has('work_history')) {
    for (const w of evidence.work_history) {
      const employerName = text(w.employer_name, 300);
      if (employerName === undefined) continue;
      const roleTitle = text(w.role_title, 300);
      const start = month(w.start_date);
      const end = month(w.end_date);
      const summary = freeText(w.experience_summary, 4000);
      const accomplishments = accomplishmentsOf(w.assertions);
      pendingAssertions.push({
        assertion_type: 'WORK_HISTORY',
        payload: {
          employer: employerName,
          ...(roleTitle ? { title: roleTitle } : {}),
          ...(start ? { start_date: start } : {}),
          ...(end ? { end_date: end } : {}),
          ...(w.start_date !== null && w.end_date === null ? { is_current: true } : {}),
          ...(summary ? { summary } : {}),
          ...(accomplishments.length > 0 ? { accomplishments } : {}),
        },
        ...sourceOf(w.source === 'resume' || w.resume_text_hash !== null),
        observed_at: iso(w.created_at),
        ...provenance(w.resume_text_hash),
      });
    }
  }

  if (!skip.has('education')) {
    for (const e of evidence.education) {
      const institution = text(e.institution_name, 300);
      if (institution === undefined) continue;
      const degree = text(e.degree_name, 200);
      const field = text(e.field_of_study, 200);
      const conferred = month(e.conferred_date);
      pendingAssertions.push({
        assertion_type: 'EDUCATION',
        payload: {
          institution,
          ...(degree ? { degree } : {}),
          ...(field ? { field_of_study: field } : {}),
          ...(conferred ? { end_date: conferred, completed: true } : {}),
        },
        ...sourceOf(e.source === 'resume' || (e.source !== 'manual' && e.resume_text_hash !== null)),
        observed_at: iso(e.created_at),
        ...provenance(e.resume_text_hash),
      });
    }
  }

  if (!skip.has('certifications')) {
    for (const c of evidence.certifications) {
      const name = text(c.certification_name, 300);
      if (name === undefined) continue;
      const issuer = text(c.issuer_name, 300);
      const credential = text(c.credential_ref, 128);
      const issued = month(c.issued_date);
      const expires = month(c.expiry_date);
      pendingAssertions.push({
        assertion_type: 'CERTIFICATION',
        payload: {
          name,
          ...(issuer ? { issuer } : {}),
          ...(issued ? { issued_on: issued } : {}),
          ...(expires ? { expires_on: expires } : {}),
          ...(credential ? { credential_id: credential } : {}),
        },
        ...sourceOf(c.source === 'resume' || (c.source !== 'manual' && c.resume_text_hash !== null)),
        observed_at: iso(c.created_at),
        ...provenance(c.resume_text_hash),
      });
    }
  }

  if (!skip.has('projects')) {
    for (const p of evidence.projects) {
      const name = text(p.project_name, 300);
      if (name === undefined) continue;
      const summary = freeText(p.context_summary, 4000);
      const start = month(p.start_date);
      const end = month(p.end_date);
      pendingAssertions.push({
        assertion_type: 'PROJECT',
        payload: { name, ...(summary ? { summary } : {}), ...(start ? { start_date: start } : {}), ...(end ? { end_date: end } : {}) },
        ...sourceOf(p.resume_text_hash !== null),
        observed_at: iso(p.created_at),
        ...provenance(p.resume_text_hash),
      });
    }
  }

  // ── per-item admission, then whole-request validation (fail closed) ───────
  const base = {
    source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
    source_tenant_id: record.tenant_id,
    external_talent_id: record.id,
    source_event_id: input.source_event_id,
    occurred_at: input.occurred_at,
  } as const;
  const dropped: BuildIngestResult['dropped'] = [];
  const admit = <T>(items: T[], label: string, probe: (item: T) => TalentIngestRequest): T[] =>
    items.filter((item, i) => {
      const r = validateTalentIngestRequest(probe(item));
      if (r.ok) return true;
      // The probe holds the item at index 0; report it at its own index.
      for (const issue of r.issues) dropped.push({ path: `${label}[${i}] (${issue.path})`, code: issue.code });
      return false;
    });

  const admittedEmails = admit(emails, '$.identity.emails', (e) => ({ ...base, identity: { emails: [e] }, assertions: [] }));
  const admittedPhones = admit(phones, '$.identity.phones', (p) => ({ ...base, identity: { phones: [p] }, assertions: [] }));
  const admittedAssertions = admit(pendingAssertions, '$.assertions', (a) => ({ ...base, identity: {}, assertions: [a] }));

  const request: TalentIngestRequest = {
    ...base,
    identity: {
      ...(names.first !== undefined || names.last !== undefined ? { names } : {}),
      ...(admittedEmails.length > 0 ? { emails: admittedEmails } : {}),
      ...(admittedPhones.length > 0 ? { phones: admittedPhones } : {}),
    },
    assertions: admittedAssertions,
  };
  const verdict = validateTalentIngestRequest(request);
  if (!verdict.ok) throw new IngestPayloadRejectedError(verdict.issues.map((i) => ({ path: i.path, code: i.code })));
  return { request: verdict.value, dropped };
}
