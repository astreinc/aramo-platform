import { describe, expect, it } from 'vitest';

import {
  buildResumeObjectKey,
  parseResumeObjectKey,
  sanitizeFilenameForKey,
  RESUME_KEY_DOCUMENT_TYPE,
} from '../lib/key-convention.js';

const TENANT_ID = '8f9e4c2a-6b1d-4d7e-8a9f-1c2b3d4e5f60';
const TALENT_RECORD_ID = '7e8d9c4a-5b6c-4a8e-9f1d-2a3b4c5d6e7f';
const REQ_ID = 'key-convention-test';

describe('A8-3a — buildResumeObjectKey', () => {
  it('produces a 5-segment tenant-scoped key with the resume document_type', () => {
    const key = buildResumeObjectKey({
      tenant_id: TENANT_ID,
      talent_record_id: TALENT_RECORD_ID,
      filename: 'Jane Doe Resume.pdf',
      requestId: REQ_ID,
    });
    const parts = key.split('/');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe(TENANT_ID);
    expect(parts[1]).toBe('talent');
    expect(parts[2]).toBe(TALENT_RECORD_ID);
    expect(parts[3]).toBe(RESUME_KEY_DOCUMENT_TYPE);
    // last segment starts with a uuid + hyphen, then the sanitized filename
    expect(parts[4]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-Jane_Doe_Resume\.pdf$/i,
    );
  });

  it('produces a distinct uuid per call (collision-safe)', () => {
    const a = buildResumeObjectKey({
      tenant_id: TENANT_ID,
      talent_record_id: TALENT_RECORD_ID,
      filename: 'r.pdf',
      requestId: REQ_ID,
    });
    const b = buildResumeObjectKey({
      tenant_id: TENANT_ID,
      talent_record_id: TALENT_RECORD_ID,
      filename: 'r.pdf',
      requestId: REQ_ID,
    });
    expect(a).not.toBe(b);
  });

  it('rejects a non-UUID tenant_id (VALIDATION_ERROR)', () => {
    expect(() =>
      buildResumeObjectKey({
        tenant_id: 'not-a-uuid',
        talent_record_id: TALENT_RECORD_ID,
        filename: 'r.pdf',
        requestId: REQ_ID,
      }),
    ).toThrow(/tenant_id must be a UUID/);
  });

  it('rejects a non-UUID talent_record_id (VALIDATION_ERROR)', () => {
    expect(() =>
      buildResumeObjectKey({
        tenant_id: TENANT_ID,
        talent_record_id: '../../etc/passwd',
        filename: 'r.pdf',
        requestId: REQ_ID,
      }),
    ).toThrow(/talent_record_id must be a UUID/);
  });

  it('rejects empty filename (VALIDATION_ERROR)', () => {
    expect(() =>
      buildResumeObjectKey({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: '',
        requestId: REQ_ID,
      }),
    ).toThrow(/filename must be non-empty/);
  });
});

describe('A8-3a — sanitizeFilenameForKey', () => {
  it('strips path components', () => {
    expect(sanitizeFilenameForKey('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilenameForKey('..\\..\\secret.txt')).toBe('secret.txt');
  });

  it('replaces non-safe chars with underscore', () => {
    expect(sanitizeFilenameForKey('résumé final v2.pdf')).toBe('r_sum__final_v2.pdf');
  });

  it('caps length', () => {
    const long = 'a'.repeat(500) + '.pdf';
    const safe = sanitizeFilenameForKey(long);
    expect(safe.length).toBeLessThanOrEqual(200);
  });

  it('falls back to "file" on empty input', () => {
    expect(sanitizeFilenameForKey('')).toBe('file');
    expect(sanitizeFilenameForKey('/')).toBe('file');
  });
});

describe('A8-3a — parseResumeObjectKey', () => {
  it('round-trips a generated key', () => {
    const key = buildResumeObjectKey({
      tenant_id: TENANT_ID,
      talent_record_id: TALENT_RECORD_ID,
      filename: 'cv.pdf',
      requestId: REQ_ID,
    });
    const parsed = parseResumeObjectKey(key);
    expect(parsed).not.toBeNull();
    expect(parsed?.tenant_id).toBe(TENANT_ID);
    expect(parsed?.talent_record_id).toBe(TALENT_RECORD_ID);
    expect(parsed?.document_type).toBe(RESUME_KEY_DOCUMENT_TYPE);
    expect(parsed?.filename).toBe('cv.pdf');
  });

  it('returns null on shape mismatch (legacy / non-A8-3a key)', () => {
    expect(parseResumeObjectKey('legacy/key/format')).toBeNull();
    expect(parseResumeObjectKey('')).toBeNull();
    expect(parseResumeObjectKey('a/b/c/d/e/f')).toBeNull();
  });

  it('returns null on non-UUID tenant component', () => {
    expect(
      parseResumeObjectKey(
        `nonuuid/talent/${TALENT_RECORD_ID}/resume/00000000-0000-7000-8000-000000000000-r.pdf`,
      ),
    ).toBeNull();
  });

  it('returns null on non-"talent" owner segment', () => {
    expect(
      parseResumeObjectKey(
        `${TENANT_ID}/requisition/${TALENT_RECORD_ID}/resume/00000000-0000-7000-8000-000000000000-r.pdf`,
      ),
    ).toBeNull();
  });
});
