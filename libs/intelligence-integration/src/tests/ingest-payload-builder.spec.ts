import { describe, expect, it } from 'vitest';
import { isClassCKey, isDocumentKey, validateTalentIngestRequest } from '@aramo/intelligence-contracts';
import type { IntelligenceEvidenceSnapshot } from '@aramo/talent-evidence';
import type { AdmissibleTalentRecord } from '@aramo/talent-record';

import { IngestPayloadRejectedError, buildTalentIngestRequest, mapWorkAuthorization } from '../lib/ingest-payload-builder.js';

// ATI-SEP-1 T8 — the publisher's admission payload: Class A / B only, never
// Class C, never a document, always validator-clean.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = '22222222-2222-7222-8222-222222222222';
const HASH = 'a'.repeat(64);

// Sentinel values planted in every Class C / document column of a FULL row: none
// may appear anywhere in the built payload.
const CLASS_C_SENTINELS = {
  notes: 'SENTINEL-NOTES do not hire',
  current_pay: 'SENTINEL-PAY 150000',
  desired_pay: 'SENTINEL-DESIRED 180000',
  source: 'SENTINEL-SOURCE referral',
  is_hot: true,
  address: 'SENTINEL-ADDRESS 1 Main St',
  address2: 'SENTINEL-ADDRESS2 Apt 4',
  zip: 'SENTINEL-ZIP 90210',
  best_time_to_call: 'SENTINEL-BTTC evenings',
  owner_id: '99999999-9999-7999-8999-999999999999',
  source_channel: 'SENTINEL-CHANNEL',
  import_batch_id: '88888888-8888-7888-8888-888888888888',
};
const DOCUMENT_SENTINELS = {
  source_document_id: '77777777-7777-7777-8777-777777777777',
  storage_key: 'SENTINEL-KEY tenant/resumes/x.pdf',
  evidence_text: 'SENTINEL-EVIDENCE-TEXT raw resume line',
  description_text: 'SENTINEL-DESCRIPTION raw resume paragraph',
  source_refs: ['SENTINEL-REF-B003'],
};

/** A FULL TalentRecord row (every column, Class C included) — the builder must read only the allowlist. */
function fullRecord(over: Partial<AdmissibleTalentRecord> = {}): AdmissibleTalentRecord {
  return {
    id: TALENT,
    tenant_id: TENANT,
    record_status: 'live',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    email2: 'ada.l@example.org',
    phone_cell: '(555) 123-0000',
    phone_home: '555 987 0000',
    phone_work: null,
    city: 'Austin',
    state: 'TX',
    country: 'US',
    current_employer: 'Analytical Engines',
    title: 'Principal Engineer',
    web_site: 'https://ada.example.com/about',
    availability_status: 'open_to_offers',
    date_available: new Date('2026-11-01T00:00:00Z'),
    work_authorization: 'US_CITIZEN',
    updated_at: new Date('2026-10-20T10:00:00Z'),
    ...CLASS_C_SENTINELS,
    ...over,
  } as AdmissibleTalentRecord;
}

function fullEvidence(): IntelligenceEvidenceSnapshot {
  const created_at = new Date('2026-10-01T09:00:00Z');
  return {
    skills: [
      { id: 's1', surface_form: 'SQL', source: 'declared', proficiency_claim: 'expert', years_claimed: 9, usage_end: new Date('2026-09-01'), resume_text_hash: HASH, created_at, ...DOCUMENT_SENTINELS },
      { id: 's2', surface_form: 'Rust', source: 'declared', proficiency_claim: null, years_claimed: null, usage_end: null, resume_text_hash: null, created_at },
      { id: 's3', surface_form: 'sql', source: 'derived', proficiency_claim: null, years_claimed: 2, usage_end: null, resume_text_hash: null, created_at },
    ],
    work_history: [
      {
        id: 'w1',
        employer_name: 'Analytical Engines',
        role_title: 'Principal Engineer',
        start_date: new Date('2019-03-01'),
        end_date: null,
        location: 'Austin, TX',
        experience_summary: 'Leads the compute platform.',
        source: 'resume',
        resume_text_hash: HASH,
        assertions: [
          { type: 'ACCOMPLISHMENT', statement: 'Cut latency by 40%', source_refs: ['B1'] },
          { type: 'ACCOMPLISHMENT', statement: 'See https://drive.google.com/file/x for slides', source_refs: ['B2'] },
          { type: '', statement: 'dropped — no type' },
        ],
        created_at,
        ...DOCUMENT_SENTINELS,
      },
      { id: 'w2', employer_name: 'Babbage & Co', role_title: 'Engineer', start_date: new Date('2015-01-01'), end_date: new Date('2019-02-01'), location: null, experience_summary: null, source: 'manual', resume_text_hash: null, assertions: null, created_at },
    ],
    education: [
      { id: 'e1', institution_name: 'University of London', degree_name: 'BSc', field_of_study: 'Mathematics', conferred_date: new Date('2014-06-01'), source: 'resume', resume_text_hash: HASH, created_at },
      { id: 'e2', institution_name: 'Night School', degree_name: 'Certificate', field_of_study: null, conferred_date: null, source: 'manual', resume_text_hash: null, created_at },
    ],
    certifications: [
      { id: 'c1', certification_name: 'AWS Solutions Architect', issuer_name: 'Amazon', credential_ref: 'AWS-123', issued_date: new Date('2022-01-01'), expiry_date: new Date('2027-01-01'), source: 'manual', resume_text_hash: null, created_at },
    ],
    projects: [
      { id: 'p1', project_name: 'Difference Engine', context_summary: 'Rebuilt the core', start_date: new Date('2020-01-01'), end_date: new Date('2021-01-01'), resume_text_hash: HASH, created_at },
      { id: 'p2', project_name: null, context_summary: 'nameless', start_date: null, end_date: null, resume_text_hash: null, created_at },
    ],
    work_authorizations: [
      {
        id: 'wa1',
        talent_id: TALENT,
        tenant_id: TENANT,
        work_authorization_status: 'VISA_HOLDER',
        authorized_to_work_in: ['US'],
        visa_type: 'H-1B',
        requires_sponsorship: true,
        updated_at: created_at,
        asserted_at: created_at,
        effective_from: null,
        effective_to: null,
        expires_at: null,
      },
    ],
  } as unknown as IntelligenceEvidenceSnapshot;
}

function allKeysAndStrings(v: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (typeof v === 'string') strings.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allKeysAndStrings(x, keys, strings));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      keys.push(k);
      allKeysAndStrings(x, keys, strings);
    }
  }
  return { keys, strings };
}

const ASSERTION_KEYS_ALLOWED_AS_SCHEMA = new Set(['source_kind', 'source_document_hash', 'source_system_id', 'source_tenant_id', 'source_event_id', 'url']);

function assertNoClassCOrDocuments(payload: unknown): void {
  const { keys, strings } = allKeysAndStrings(payload);
  for (const k of keys) {
    if (ASSERTION_KEYS_ALLOWED_AS_SCHEMA.has(k)) continue;
    expect(isClassCKey(k), `Class C key ${k}`).toBe(false);
    expect(isDocumentKey(k), `document key ${k}`).toBe(false);
  }
  const blob = strings.join('\n');
  expect(blob).not.toMatch(/SENTINEL/);
  expect(blob).not.toContain(DOCUMENT_SENTINELS.source_document_id);
  expect(blob).not.toContain(CLASS_C_SENTINELS.owner_id);
}

describe('ATI-SEP-1 T8 — buildTalentIngestRequest', () => {
  it('a FULLY populated talent: validator-clean, Class A/B only, no Class C, no document field', () => {
    const { request, dropped } = buildTalentIngestRequest({
      source_event_id: 'evt-1',
      occurred_at: '2026-10-20T10:00:00.000Z',
      record: fullRecord(),
      evidence: fullEvidence(),
      now: new Date('2026-10-23T00:00:00Z'),
    });
    expect(validateTalentIngestRequest(request).ok).toBe(true);
    assertNoClassCOrDocuments(request);
    expect(request.source_system_id).toBe('ARAMO_ATS');
    expect(request.source_event_id).toBe('evt-1');
    expect(request.external_talent_id).toBe(TALENT);
    const types = request.assertions.map((a) => a.assertion_type).sort();
    expect(types).toEqual(
      [
        'AVAILABILITY',
        'CERTIFICATION',
        'CURRENT_EMPLOYER',
        'EDUCATION',
        'EDUCATION',
        'LOCATION',
        'PROJECT',
        'PUBLIC_PROFILE_URL',
        'SKILL',
        'SKILL',
        'TITLE',
        'WORK_AUTHORIZATION',
        'WORK_HISTORY',
        'WORK_HISTORY',
      ].sort(),
    );
    // The accomplishment carrying a storage URL is dropped (never sent); the entry and its other statements survive.
    const wh = request.assertions.find((a) => a.assertion_type === 'WORK_HISTORY' && a.payload.employer === 'Analytical Engines');
    expect(wh?.assertion_type === 'WORK_HISTORY' && wh.payload.accomplishments).toEqual(['Cut latency by 40%']);
    expect(JSON.stringify(request)).not.toContain('drive.google.com');
    expect(dropped).toEqual([]);
  });

  it('emails / phones: email1 + phone_cell are primary; every identifier is UNVERIFIED (no ATS verified signal)', () => {
    const { request } = buildTalentIngestRequest({ source_event_id: 'e', occurred_at: '2026-10-20T10:00:00.000Z', record: fullRecord(), evidence: fullEvidence() });
    expect(request.identity.emails).toEqual([
      { value: 'ada@example.com', is_primary: true, verification: { status: 'UNVERIFIED' } },
      { value: 'ada.l@example.org', is_primary: false, verification: { status: 'UNVERIFIED' } },
    ]);
    expect(request.identity.phones?.[0]).toEqual({ value: '(555) 123-0000', is_primary: true, verification: { status: 'UNVERIFIED' } });
    expect(request.identity.names).toEqual({ first: 'Ada', last: 'Lovelace' });
  });

  it('résumé-derived entries are RESUME_DERIVED + ai_derived with only an opaque source_document_hash; recruiter entries are RECRUITER', () => {
    const { request } = buildTalentIngestRequest({ source_event_id: 'e', occurred_at: '2026-10-20T10:00:00.000Z', record: fullRecord(), evidence: fullEvidence() });
    const sql = request.assertions.find((a) => a.assertion_type === 'SKILL' && a.payload.name === 'SQL');
    expect(sql).toMatchObject({ source_kind: 'RESUME_DERIVED', ai_derived: true, provenance: { source_document_hash: HASH } });
    const cert = request.assertions.find((a) => a.assertion_type === 'CERTIFICATION');
    expect(cert).toMatchObject({ source_kind: 'RECRUITER', ai_derived: false });
    expect(cert && 'provenance' in cert).toBe(false);
    // Skills dedupe case-insensitively (SQL / sql).
    expect(request.assertions.filter((a) => a.assertion_type === 'SKILL')).toHaveLength(2);
  });

  it('work authorization: TI-1G current state (VISA_HOLDER + sponsorship → REQUIRES_SPONSORSHIP), never résumé-derived', () => {
    const { request } = buildTalentIngestRequest({ source_event_id: 'e', occurred_at: '2026-10-20T10:00:00.000Z', record: fullRecord(), evidence: fullEvidence() });
    const wa = request.assertions.find((a) => a.assertion_type === 'WORK_AUTHORIZATION');
    expect(wa).toMatchObject({ payload: { status: 'REQUIRES_SPONSORSHIP', jurisdiction: 'US' }, source_kind: 'RECRUITER', ai_derived: false });
    expect(mapWorkAuthorization('NOT_DISCLOSED', false)).toBeNull();
    expect(mapWorkAuthorization('US_CITIZEN', false)).toBe('CITIZEN');
  });

  it('fields whose current value came FROM Talent Intelligence are not echoed back', () => {
    const { request } = buildTalentIngestRequest({
      source_event_id: 'e',
      occurred_at: '2026-10-20T10:00:00.000Z',
      record: fullRecord(),
      evidence: fullEvidence(),
      intelligence_sourced_fields: new Set(['availability', 'title']),
    });
    const types = request.assertions.map((a) => a.assertion_type);
    expect(types).not.toContain('AVAILABILITY');
    expect(types).not.toContain('TITLE');
    expect(types).toContain('CURRENT_EMPLOYER');
  });

  it('PROPERTY — 300 random partial talents: always validator-clean, never Class C, never a document', () => {
    let seed = 20261023;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(v: T): T | null => (rnd() < 0.4 ? null : v);
    const odd = ['', '   ', 'x'.repeat(5000), 'data:application/pdf;base64,AAAA', 's3://bucket/key.pdf', 'https://x.s3.amazonaws.com/a?X-Amz-Signature=1', 'not-a-url', 'A'.repeat(300)];
    for (let i = 0; i < 300; i++) {
      const weird = () => (rnd() < 0.25 ? odd[Math.floor(rnd() * odd.length)] : null);
      const record = fullRecord({
        email1: weird() ?? pick('ada@example.com'),
        email2: weird() ?? pick('ada@example.com'),
        phone_cell: weird() ?? pick('+1 555 000 1111'),
        phone_home: weird() ?? pick('12'),
        city: weird() ?? pick('Austin'),
        state: pick('TX'),
        current_employer: weird() ?? pick('Acme'),
        title: weird() ?? pick('Engineer'),
        web_site: weird() ?? pick(rnd() < 0.5 ? 'https://ada.example.com/cv.pdf' : 'https://ada.example.com/'),
        availability_status: pick('available_now'),
        date_available: pick(new Date('2027-01-01')),
        work_authorization: pick('OTHER'),
      });
      const evidence = fullEvidence();
      evidence.skills.push({ id: `sx${i}`, surface_form: weird() ?? 'Go', source: 'declared', proficiency_claim: weird(), years_claimed: rnd() < 0.5 ? 120 : 3, usage_end: null, resume_text_hash: rnd() < 0.5 ? 'not-a-hash' : null, created_at: new Date() });
      if (rnd() < 0.5) evidence.work_authorizations = [];
      const { request } = buildTalentIngestRequest({ source_event_id: `evt-${i}`, occurred_at: '2026-10-20T10:00:00.000Z', record, evidence });
      expect(validateTalentIngestRequest(request).ok).toBe(true);
      assertNoClassCOrDocuments(request);
    }
  });

  it('an item the admission validator refuses is DROPPED, never sent (a document URL as the profile URL)', () => {
    const { request, dropped } = buildTalentIngestRequest({
      source_event_id: 'e',
      occurred_at: '2026-10-20T10:00:00.000Z',
      record: fullRecord({ web_site: 'https://bucket.s3.amazonaws.com/resume.pdf' }),
      evidence: fullEvidence(),
    });
    expect(request.assertions.map((a) => a.assertion_type)).not.toContain('PUBLIC_PROFILE_URL');
    expect(dropped.some((d) => d.code === 'DOCUMENT_REJECTED')).toBe(true);
    expect(JSON.stringify(request)).not.toContain('amazonaws');
  });

  it('FAILS CLOSED when the assembled request is still refused (an invalid envelope id)', () => {
    expect(() =>
      buildTalentIngestRequest({ source_event_id: 'bad id with spaces', occurred_at: '2026-10-20T10:00:00.000Z', record: fullRecord(), evidence: fullEvidence() }),
    ).toThrow(IngestPayloadRejectedError);
  });
});
