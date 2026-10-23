import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FIELD_CATALOGUE,
  ASSERTION_ADMISSION_CLASS,
  ASSERTION_TYPES,
  isAuthoritativeWorkAuthorization,
  isClassCKey,
  isDocumentKey,
  validateTalentErasedRequest,
  validateTalentIngestRequest,
} from '../index.js';

// ATI-SEP-1 T2 (ADR-0036 Decision 4) — the closed admission schema. Every
// refusal path is exercised: unknown keys, document keys/values (incl. nested
// and obfuscated attempts), Class C keys, and value/type errors.

const HASH = 'a'.repeat(64);

function valid(): Record<string, unknown> {
  return {
    source_system_id: 'ARAMO_ATS',
    source_tenant_id: '019a0000-0000-7000-8000-00000000000a',
    external_talent_id: '019a0000-0000-7000-8000-00000000000b',
    source_event_id: '019a0000-0000-7000-8000-00000000000c',
    occurred_at: '2026-10-23T10:00:00.000Z',
    identity: {
      names: { first: 'Priya', last: 'Raman', aliases: ['Priya R.'] },
      emails: [
        {
          value: 'priya@example.com',
          is_primary: true,
          verification: { status: 'VERIFIED', method: 'EMAIL_OTP', source: 'ARAMO_PORTAL', verified_at: '2026-10-01T00:00:00Z' },
        },
        { value: 'priya.raman@example.org', is_primary: false },
      ],
      phones: [{ value: '+1 (555) 010-2000', is_primary: true }],
      government_ids: [{ value: '123-45-6789', jurisdiction: 'US', identifier_class: 'SSN' }],
    },
    assertions: [
      { assertion_type: 'SKILL', payload: { name: 'TypeScript', years: 6 }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00Z' },
      {
        assertion_type: 'WORK_HISTORY',
        payload: {
          employer: 'Acme',
          title: 'Engineer',
          start_date: '2020-01',
          is_current: true,
          location: { city: 'Austin', region: 'TX', country: 'US' },
          accomplishments: ['Shipped the platform'],
        },
        source_kind: 'RESUME_DERIVED',
        observed_at: '2026-10-23T10:00:00Z',
        ai_derived: true,
        provenance: { source_document_hash: HASH },
      },
      { assertion_type: 'EDUCATION', payload: { institution: 'UT Austin', degree: 'BS' }, source_kind: 'RESUME_DERIVED', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'CERTIFICATION', payload: { name: 'AWS SA', issuer: 'AWS' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'PROJECT', payload: { name: 'Search' }, source_kind: 'TALENT_SELF', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'CURRENT_EMPLOYER', payload: { name: 'Acme' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'TITLE', payload: { value: 'Engineer' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'LOCATION', payload: { city: 'Austin', country: 'US' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'PUBLIC_PROFILE_URL', payload: { url: 'https://github.com/priya', label: 'GitHub' }, source_kind: 'TALENT_SELF', observed_at: '2026-10-23T10:00:00Z' },
      { assertion_type: 'AVAILABILITY', payload: { status: 'AVAILABLE', date_available: '2026-11-01' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00Z', valid_to: '2026-12-31' },
      { assertion_type: 'WORK_AUTHORIZATION', payload: { status: 'AUTHORIZED', jurisdiction: 'US' }, source_kind: 'RESUME_DERIVED', observed_at: '2026-10-23T10:00:00Z' },
      {
        assertion_type: 'VERIFICATION_OUTCOME',
        payload: { target: 'EMPLOYMENT', result: 'CONFIRMED', method: 'REFERENCE_CALL', verified_at: '2026-10-20T00:00:00Z' },
        source_kind: 'RECRUITER',
        observed_at: '2026-10-23T10:00:00Z',
      },
    ],
  };
}

type Mutator = (body: Record<string, unknown>) => void;
const identity = (b: Record<string, unknown>) => b['identity'] as Record<string, unknown>;
const assertions = (b: Record<string, unknown>) => b['assertions'] as Array<Record<string, unknown>>;
const payloadOf = (b: Record<string, unknown>, i: number) => assertions(b)[i]!['payload'] as Record<string, unknown>;

function run(mutate: Mutator) {
  const body = valid();
  mutate(body);
  return validateTalentIngestRequest(JSON.parse(JSON.stringify(body)));
}

function codeOf(mutate: Mutator): string {
  const r = run(mutate);
  return r.ok ? 'OK' : r.code;
}

describe('admission catalogue', () => {
  it('classes every assertion type (A professional, B identity/eligibility)', () => {
    expect(ASSERTION_TYPES.filter((t) => ASSERTION_ADMISSION_CLASS[t] === 'A')).toEqual([
      'SKILL', 'WORK_HISTORY', 'EDUCATION', 'CERTIFICATION', 'PROJECT', 'CURRENT_EMPLOYER', 'TITLE', 'LOCATION', 'PUBLIC_PROFILE_URL', 'AVAILABILITY',
    ]);
    expect(ASSERTION_TYPES.filter((t) => ASSERTION_ADMISSION_CLASS[t] === 'B')).toEqual(['NAME', 'WORK_AUTHORIZATION', 'VERIFICATION_OUTCOME']);
  });

  it('lists every admitted field once with its class', () => {
    const fields = ADMISSION_FIELD_CATALOGUE.map((f) => f.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect(ADMISSION_FIELD_CATALOGUE.filter((f) => f.admission_class === 'B').map((f) => f.field)).toEqual([
      'names', 'emails', 'phones', 'government_ids', 'work_authorization', 'verification_outcomes',
    ]);
  });

  it('résumé-sourced or AI-derived work authorization is non-authoritative', () => {
    expect(isAuthoritativeWorkAuthorization('RESUME_DERIVED', false)).toBe(false);
    expect(isAuthoritativeWorkAuthorization('RECRUITER', true)).toBe(false);
    expect(isAuthoritativeWorkAuthorization('TALENT_SELF', false)).toBe(true);
  });
});

describe('validateTalentIngestRequest — accepts', () => {
  it('a full valid snapshot covering every ingestible assertion type', () => {
    const r = validateTalentIngestRequest(valid());
    expect(r).toMatchObject({ ok: true });
  });

  it('a minimal snapshot (empty identity, no assertions)', () => {
    const body = valid();
    body['identity'] = {};
    body['assertions'] = [];
    expect(validateTalentIngestRequest(body).ok).toBe(true);
  });

  it('keys that merely contain "profile" (not a file)', () => {
    expect(isDocumentKey('public_profile_urls')).toBe(true); // *_urls — refused anywhere it is not the closed schema
    expect(isDocumentKey('profile')).toBe(false);
    expect(isDocumentKey('proficiency')).toBe(false);
  });
});

describe('validateTalentIngestRequest — closed schema (INVALID_REQUEST)', () => {
  const cases: Array<[string, Mutator]> = [
    ['unknown root key', (b) => (b['extra'] = 1)],
    ['unknown identity key', (b) => (identity(b)['nickname'] = 'P')],
    ['unknown name key', (b) => ((identity(b)['names'] as Record<string, unknown>)['middle'] = 'K')],
    ['unknown email key', (b) => ((identity(b)['emails'] as Array<Record<string, unknown>>)[0]!['label'] = 'work')],
    ['unknown verification key', (b) => (((identity(b)['emails'] as Array<Record<string, unknown>>)[0]!['verification'] as Record<string, unknown>)['otp'] = '1234')],
    ['unknown assertion key', (b) => (assertions(b)[0]!['confidence'] = 0.9)],
    ['unknown payload key', (b) => (payloadOf(b, 0)['category'] = 'lang')],
    ['unknown nested location key', (b) => (((payloadOf(b, 1)['location'] as Record<string, unknown>)['lat'] = 1))],
    ['__proto__ key', (b) => Object.defineProperty(b, '__proto__', { value: { x: 1 }, enumerable: true })],
    ['constructor key', (b) => (b['constructor'] = 'x')],
    ['unknown assertion type', (b) => (assertions(b)[0]!['assertion_type'] = 'HOBBY')],
    ['NAME as an assertion (identity block only)', (b) => (assertions(b)[0]!['assertion_type'] = 'NAME')],
    ['sender claims TI_ACQUIRED', (b) => (assertions(b)[0]!['source_kind'] = 'TI_ACQUIRED')],
    ['sender claims VERIFICATION source kind', (b) => (assertions(b)[0]!['source_kind'] = 'VERIFICATION')],
    ['unknown source system', (b) => (b['source_system_id'] = 'OTHER_ATS')],
    ['missing source_event_id', (b) => delete b['source_event_id']],
    ['missing identity', (b) => delete b['identity']],
    ['missing assertions', (b) => delete b['assertions']],
    ['bad occurred_at', (b) => (b['occurred_at'] = 'yesterday')],
    ['id with spaces', (b) => (b['external_talent_id'] = 'a b')],
    ['null where optional', (b) => (assertions(b)[0]!['valid_from'] = null)],
    ['bad email', (b) => ((identity(b)['emails'] as Array<Record<string, unknown>>)[0]!['value'] = 'not-an-email')],
    ['bad phone', (b) => ((identity(b)['phones'] as Array<Record<string, unknown>>)[0]!['value'] = '12')],
    ['verified without method', (b) => delete (((identity(b)['emails'] as Array<Record<string, unknown>>)[0]!['verification'] as Record<string, unknown>)['method'])],
    ['is_primary missing', (b) => delete (identity(b)['emails'] as Array<Record<string, unknown>>)[0]!['is_primary']],
    ['skill without name', (b) => delete payloadOf(b, 0)['name']],
    ['years out of range', (b) => (payloadOf(b, 0)['years'] = 500)],
    ['years as string', (b) => (payloadOf(b, 0)['years'] = '6')],
    ['bad partial date', (b) => (payloadOf(b, 1)['start_date'] = 'Jan 2020')],
    ['empty location', (b) => (assertions(b)[7]!['payload'] = {})],
    ['bad availability status', (b) => (payloadOf(b, 9)['status'] = 'MAYBE')],
    ['bad work authorization status', (b) => (payloadOf(b, 10)['status'] = 'H1B')],
    ['résumé-derived verification outcome', (b) => (assertions(b)[11]!['source_kind'] = 'RESUME_DERIVED')],
    ['bad source_document_hash', (b) => ((assertions(b)[1]!['provenance'] as Record<string, unknown>)['source_document_hash'] = 'xyz')],
    ['profile URL with credentials', (b) => (payloadOf(b, 8)['url'] = 'https://u:p@github.com/priya')],
    ['javascript: profile URL', (b) => (payloadOf(b, 8)['url'] = 'javascript:alert(1)')],
    ['empty object', (b) => Object.keys(b).forEach((k) => delete b[k])],
    ['blank string', (b) => (payloadOf(b, 0)['name'] = '   ')],
    ['too long string', (b) => (payloadOf(b, 0)['name'] = 'x '.repeat(200))],
    ['too many emails', (b) => (identity(b)['emails'] = Array.from({ length: 21 }, (_, i) => ({ value: `a${i}@x.io`, is_primary: false })))],
  ];

  it.each(cases)('%s → INVALID_REQUEST', (_name, mutate) => {
    expect(codeOf(mutate)).toBe('INVALID_REQUEST');
  });

  it('refuses non-objects at the root', () => {
    for (const v of [null, undefined, 'x', 1, [valid()]]) {
      const r = validateTalentIngestRequest(v);
      expect(r.ok).toBe(false);
    }
  });

  it('reports the JSON path and issue code of each problem', () => {
    const r = run((b) => (payloadOf(b, 0)['category'] = 'lang'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual([{ path: '$.assertions[0].payload.category', code: 'UNKNOWN_KEY', message: "unknown field 'category'" }]);
  });
});

describe('validateTalentIngestRequest — documents (DOCUMENT_REJECTED)', () => {
  const docKeys = [
    'storage_key', 'storageKey', 'Storage-Key', 'resume_url', 'resumeUrl', 'document_url', 'photo_uri', 'presigned', 'presigned_get',
    'file', 'files', 'File_Name', 'resumefile', 'attachment', 'attachments', 'document', 'documents', 'resume_document', 'bytes',
    'binary', 'base64', 'blob', 'content', 'raw_content', 'data_uri', 'dataUrl', 's3_key', 'object_key', 'bucket', 'upload_id', 'href',
    'public_profile_urls',
  ];

  it.each(docKeys)('root key %s', (key) => {
    expect(codeOf((b) => (b[key] = 'x'))).toBe('DOCUMENT_REJECTED');
  });

  it.each(docKeys)('payload key %s', (key) => {
    expect(codeOf((b) => (payloadOf(b, 0)[key] = 'x'))).toBe('DOCUMENT_REJECTED');
  });

  it('a document key hidden inside an unknown subtree', () => {
    expect(codeOf((b) => (b['meta'] = { nested: [{ deeper: { resume_document: 'x' } }] }))).toBe('DOCUMENT_REJECTED');
  });

  it('a document key hidden under an unknown payload key', () => {
    expect(codeOf((b) => (payloadOf(b, 0)['extra'] = { attachments: [] }))).toBe('DOCUMENT_REJECTED');
  });

  it('a document key on a provenance block (only source_document_hash is admitted)', () => {
    expect(codeOf((b) => ((assertions(b)[1]!['provenance'] as Record<string, unknown>)['source_document_url'] = 'x'))).toBe('DOCUMENT_REJECTED');
    expect(codeOf((b) => ((assertions(b)[1]!['provenance'] as Record<string, unknown>)['storage_key'] = 'k'))).toBe('DOCUMENT_REJECTED');
  });

  it('a document as an assertion type', () => {
    expect(codeOf((b) => (assertions(b)[0]!['assertion_type'] = 'RESUME_DOCUMENT'))).toBe('DOCUMENT_REJECTED');
  });

  const docValues: Array<[string, string]> = [
    ['data URI', 'data:application/pdf;base64,JVBERi0xLjQK'],
    ['s3 URI', 's3://aramo-prod-resumes/t/1.pdf'],
    ['gs URI', 'gs://bucket/obj'],
    ['file URI', 'file:///etc/passwd'],
    ['presigned AWS URL', 'https://x.example.com/a?X-Amz-Signature=abc&X-Amz-Credential=k'],
    ['Azure SAS', 'https://x.example.com/a?sv=2020&se=2026&sig=abc'],
    ['plain URL in a skill name', 'https://evil.example.com/resume'],
    ['base64 blob', 'QUJD'.repeat(80)],
  ];

  it.each(docValues)('a %s as a string value', (_name, value) => {
    expect(codeOf((b) => (payloadOf(b, 0)['name'] = value))).toBe('DOCUMENT_REJECTED');
  });

  it('a document value hidden in an unknown subtree', () => {
    expect(codeOf((b) => (b['x'] = ['data:text/plain;base64,QQ==']))).toBe('DOCUMENT_REJECTED');
  });

  const profileUrls: Array<[string, string]> = [
    ['a PDF', 'https://example.com/me/resume.pdf'],
    ['a DOCX', 'https://example.com/cv.DOCX'],
    ['an S3 host', 'https://aramo.s3.amazonaws.com/x'],
    ['a Drive file', 'https://drive.google.com/file/d/1/view'],
    ['a presigned URL', 'https://cdn.example.com/x?X-Amz-Signature=1'],
    ['a data URI', 'data:text/html,hi'],
  ];

  it.each(profileUrls)('a PUBLIC_PROFILE_URL that is %s', (_name, url) => {
    expect(codeOf((b) => (payloadOf(b, 8)['url'] = url))).toBe('DOCUMENT_REJECTED');
  });

  it('documents outrank Class C and unknown keys in the overall code', () => {
    expect(codeOf((b) => { b['notes'] = 'x'; b['zzz'] = 1; b['file'] = 'x'; })).toBe('DOCUMENT_REJECTED');
  });
});

describe('validateTalentIngestRequest — Class C (CLASS_C_REJECTED)', () => {
  const classC = [
    'notes', 'Notes', 'note', 'recruiter_notes', 'current_pay', 'currentPay', 'desired_pay', 'salary', 'desired_salary',
    'compensation', 'pay', 'bill_rate', 'source', 'Source', 'lead_source', 'is_hot', 'isHot', 'hot', 'address', 'address2',
    'street', 'zip', 'zip_code', 'postal_code', 'requisition_id', 'requisitions', 'pipeline', 'pipeline_stage', 'submittal',
    'submittal_status', 'interview', 'interview_feedback', 'job_order', 'placement',
  ];

  it.each(classC)('root key %s', (key) => {
    expect(codeOf((b) => (b[key] = 'x'))).toBe('CLASS_C_REJECTED');
  });

  it.each(classC)('nested in a payload: %s', (key) => {
    expect(codeOf((b) => (payloadOf(b, 1)[key] = 'x'))).toBe('CLASS_C_REJECTED');
  });

  it('Class C under a location (street address / postal code are never professional location)', () => {
    expect(codeOf((b) => ((payloadOf(b, 1)['location'] as Record<string, unknown>)['postal_code'] = '78701'))).toBe('CLASS_C_REJECTED');
    expect(codeOf((b) => (payloadOf(b, 7)['address'] = '1 Main St'))).toBe('CLASS_C_REJECTED');
  });

  it('Class C hidden in an unknown subtree', () => {
    expect(codeOf((b) => (b['meta'] = { a: [{ b: { interview_notes: 'x' } }] }))).toBe('CLASS_C_REJECTED');
  });

  it('a Class C assertion type', () => {
    expect(codeOf((b) => (assertions(b)[0]!['assertion_type'] = 'INTERVIEW_FEEDBACK'))).toBe('CLASS_C_REJECTED');
    expect(codeOf((b) => (assertions(b)[0]!['assertion_type'] = 'DESIRED_SALARY'))).toBe('CLASS_C_REJECTED');
  });

  it('the identity verification `source` is part of the closed schema (not the Class C lead source)', () => {
    expect(isClassCKey('source')).toBe(true);
    expect(validateTalentIngestRequest(valid()).ok).toBe(true);
  });

  it('Class C outranks plain unknown keys', () => {
    expect(codeOf((b) => { b['zzz'] = 1; b['is_hot'] = true; })).toBe('CLASS_C_REJECTED');
  });
});

describe('validateTalentErasedRequest', () => {
  const ok = {
    source_system_id: 'ARAMO_ATS',
    source_tenant_id: 't-1',
    external_talent_id: 'x-1',
    source_event_id: 'e-1',
    occurred_at: '2026-10-23T10:00:00Z',
  };

  it('accepts the closed five-key shape', () => {
    expect(validateTalentErasedRequest(ok).ok).toBe(true);
  });

  it('refuses extra keys, documents and Class C', () => {
    expect(validateTalentErasedRequest({ ...ok, reason: 'x' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(validateTalentErasedRequest({ ...ok, attachments: [] })).toMatchObject({ ok: false, code: 'DOCUMENT_REJECTED' });
    expect(validateTalentErasedRequest({ ...ok, notes: 'x' })).toMatchObject({ ok: false, code: 'CLASS_C_REJECTED' });
    const missing: Record<string, unknown> = { ...ok };
    delete missing['source_event_id'];
    expect(validateTalentErasedRequest(missing)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
});
