import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TITLES,
  PERSONAL_LEGAL_DOCUMENT_KEYS,
  approvedLegalDocument,
  effectiveLegalDocument,
  legalEffectiveFrom,
  legalRef,
  legalVersionStatus,
  type LegalDocumentVersion,
} from '../lib/legal/legal-documents.js';

// Commercial Plans Amendment A1 §3 — legal texts are versioned and pinned: a text
// change without a new version fails here; a draft is never offered for acceptance.
// Aramo Sign Personal (Free) — the three Personal documents are APPROVED 1.0 and
// published on the Sign host; the Business documents stay DRAFT.

const ROOT = resolve(__dirname, '../../../..');
const BUSINESS_KEYS = ['sign.terms_of_service', 'sign.privacy_policy', 'sign.esign_consent_disclosure', 'sign.retention_policy'] as const;
const SLUGS: Record<(typeof PERSONAL_LEGAL_DOCUMENT_KEYS)[number], string> = {
  'sign.personal_terms_of_service': 'personal-terms',
  'aramo.privacy_notice': 'privacy',
  'aramo.acceptable_use_policy': 'acceptable-use',
};

describe('legal document registry', () => {
  it.each(LEGAL_DOCUMENTS.map((d) => [`${d.key}@${d.version}`, d] as const))('%s: the pinned sha256 is the file on disk', (_k, d) => {
    const text = readFileSync(resolve(ROOT, d.path));
    expect(createHash('sha256').update(text).digest('hex')).toBe(d.sha256);
  });

  it('every Business document is a DRAFT marked legal-pending in its own text, never offered', () => {
    const business = LEGAL_DOCUMENTS.filter((d) => (BUSINESS_KEYS as readonly string[]).includes(d.key));
    expect(business).toHaveLength(4);
    for (const d of business) {
      expect(d.status).toBe('DRAFT');
      expect(d.url).toBeNull();
      expect(readFileSync(resolve(ROOT, d.path), 'utf8')).toContain('DRAFT — LEGAL-PENDING');
      expect(approvedLegalDocument(d.key)).toBeNull();
    }
  });

  it('the three Personal documents are APPROVED 1.0 at their stable Sign-host URL, with no draft markers in the text', () => {
    for (const key of PERSONAL_LEGAL_DOCUMENT_KEYS) {
      const d = approvedLegalDocument(key);
      expect(d).not.toBeNull();
      expect(d!.version).toBe('1.0');
      expect(d!.url).toBe(`https://sign.aramo.ai/legal/${SLUGS[key]}/1.0`);
      const text = readFileSync(resolve(ROOT, d!.path), 'utf8');
      for (const marker of ['LEGAL_PENDING', 'LEGAL-PENDING', 'DRAFT', 'Reviewer checklist', '[Counsel', '[Legal']) expect(text).not.toContain(marker);
      expect(text).toContain('| Version | 1.0 |');
      expect(LEGAL_DOCUMENT_TITLES[key].length).toBeGreaterThan(0);
    }
  });

  it('an approved (key, version) appears once, and every APPROVED entry carries a URL', () => {
    const seen = new Set<string>();
    for (const d of LEGAL_DOCUMENTS) {
      const id = `${d.key}@${d.version}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      if (d.status === 'APPROVED') expect(d.url).toMatch(/^https:\/\/sign\.aramo\.ai\/legal\/[a-z-]+\/[0-9.]+$/);
    }
  });

  it('an approved version (with a published URL) is offered and referenced exactly', () => {
    const approved: LegalDocumentVersion = { ...LEGAL_DOCUMENTS[0]!, version: '1.0.0', status: 'APPROVED', url: 'https://aramo.ai/legal/sign/terms/1.0.0', effective_from: '2026-01-01T00:00:00Z' };
    const reg = [...LEGAL_DOCUMENTS, approved];
    expect(approvedLegalDocument('sign.terms_of_service', reg)).toBe(approved);
    expect(legalRef(approved)).toBe(`sign.terms_of_service@1.0.0#${approved.sha256}`);
    expect(approvedLegalDocument('sign.terms_of_service', [{ ...approved, url: null }])).toBeNull();
  });
});

// Privacy Notice 1.1 Remediation Directive §3 / decision 6 (E-5) — future-effective
// versions. Fixture registries only: no 1.1 is registered (its text is not approved).
describe('E-5 effective-version resolver', () => {
  const v10 = approvedLegalDocument('aramo.privacy_notice')!;
  const v11: LegalDocumentVersion = { ...v10, version: '1.1', sha256: 'a'.repeat(64), url: 'https://sign.aramo.ai/legal/privacy/1.1', effective_from: '2026-11-25T00:00:00Z' };
  const v12: LegalDocumentVersion = { ...v10, version: '1.2', sha256: 'b'.repeat(64), url: 'https://sign.aramo.ai/legal/privacy/1.2', effective_from: '2027-03-01T00:00:00Z' };
  const reg = [...LEGAL_DOCUMENTS, v11, v12];
  const at = (iso: string) => new Date(iso);
  const state = (d: LegalDocumentVersion, now: string) => legalVersionStatus(d, reg, at(now)).state;

  it('the Privacy Notice 1.0 text is byte-for-byte unchanged (SHA-256 18fcc1aa386a06c0…)', () => {
    const bytes = readFileSync(resolve(ROOT, 'doc/legal/aramo/privacy-notice.md'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('18fcc1aa386a06c0c9a15b8c60232aca6f0fbb1cdc100b288e524617f6e446b6');
    expect(v10.sha256).toBe('18fcc1aa386a06c0c9a15b8c60232aca6f0fbb1cdc100b288e524617f6e446b6');
    expect(v10.version).toBe('1.0');
  });

  it('the real registry registers no 1.1 and no upcoming version: every APPROVED entry is effective now', () => {
    expect(LEGAL_DOCUMENTS.some((d) => d.version === '1.1')).toBe(false);
    for (const d of LEGAL_DOCUMENTS) {
      if (d.status === 'DRAFT') {
        expect(d.effective_from).toBeNull();
        expect(legalVersionStatus(d).state).toBe('draft');
      } else {
        expect(d.effective_from).toBe('2026-10-21T00:00:00Z');
        expect(legalVersionStatus(d).state).toBe('effective');
      }
    }
  });

  it('every registry effective_from is null or an unambiguous ISO date-time with an offset', () => {
    for (const d of LEGAL_DOCUMENTS) if (d.effective_from !== null) expect(legalEffectiveFrom(d)).not.toBeNull();
  });

  it('before 1.1 is effective: 1.0 is effective, 1.1 and 1.2 are published and upcoming', () => {
    const now = '2026-11-01T12:00:00Z';
    expect(effectiveLegalDocument('aramo.privacy_notice', reg, at(now))).toBe(v10);
    expect(approvedLegalDocument('aramo.privacy_notice', reg, at(now))).toBe(v10);
    expect(state(v10, now)).toBe('effective');
    expect(state(v11, now)).toBe('upcoming');
    expect(state(v12, now)).toBe('upcoming');
    expect(legalVersionStatus(v11, reg, at(now)).effective_from).toEqual(at('2026-11-25T00:00:00Z'));
  });

  it('boundary: one millisecond before effective_from 1.0 still applies; AT effective_from 1.1 applies (inclusive)', () => {
    expect(effectiveLegalDocument('aramo.privacy_notice', reg, at('2026-11-24T23:59:59.999Z'))).toBe(v10);
    expect(state(v11, '2026-11-24T23:59:59.999Z')).toBe('upcoming');
    expect(effectiveLegalDocument('aramo.privacy_notice', reg, at('2026-11-25T00:00:00.000Z'))).toBe(v11);
    expect(state(v11, '2026-11-25T00:00:00Z')).toBe('effective');
  });

  it('after 1.1 is effective: 1.0 is superseded since 1.1 took effect, retained in the registry', () => {
    const s = legalVersionStatus(v10, reg, at('2026-12-01T00:00:00Z'));
    expect(s).toEqual({ state: 'superseded', effective_from: at('2026-10-21T00:00:00Z'), superseded_at: at('2026-11-25T00:00:00Z') });
    expect(state(v12, '2026-12-01T00:00:00Z')).toBe('upcoming');
    // Once 1.2 is effective, 1.1 is superseded since 1.2's date, 1.0 since 1.1's.
    expect(legalVersionStatus(v11, reg, at('2027-03-01T00:00:00Z')).superseded_at).toEqual(at('2027-03-01T00:00:00Z'));
    expect(legalVersionStatus(v10, reg, at('2027-03-01T00:00:00Z')).superseded_at).toEqual(at('2026-11-25T00:00:00Z'));
    expect(effectiveLegalDocument('aramo.privacy_notice', reg, at('2027-03-01T00:00:00Z'))).toBe(v12);
  });

  it('timezone: an offset effective_from is compared as an instant (2026-11-25T00:00-05:00 = 05:00Z)', () => {
    const est: LegalDocumentVersion = { ...v11, effective_from: '2026-11-25T00:00:00-05:00' };
    const r = [...LEGAL_DOCUMENTS, est];
    expect(effectiveLegalDocument('aramo.privacy_notice', r, at('2026-11-25T04:59:59.999Z'))).toBe(v10);
    expect(effectiveLegalDocument('aramo.privacy_notice', r, at('2026-11-25T05:00:00Z'))).toBe(est);
    expect(effectiveLegalDocument('aramo.privacy_notice', r, at('2026-11-25T00:00:00+05:30'))).toBe(v10);
  });

  it('approved but not yet effective: unscheduled, no URL, or an ambiguous/invalid date is never effective', () => {
    for (const bad of [null, '2026-11-25', '2026-11-25T00:00:00', 'soon', '2026-13-45T00:00:00Z']) {
      const d: LegalDocumentVersion = { ...v11, effective_from: bad };
      const r = [...LEGAL_DOCUMENTS, d];
      expect(legalVersionStatus(d, r, at('2030-01-01T00:00:00Z')).state).toBe('approved_not_effective');
      expect(effectiveLegalDocument('aramo.privacy_notice', r, at('2030-01-01T00:00:00Z'))).toBe(v10);
    }
    const noUrl: LegalDocumentVersion = { ...v11, url: null, effective_from: '2026-01-01T00:00:00Z' };
    expect(legalVersionStatus(noUrl, [...LEGAL_DOCUMENTS, noUrl], at('2030-01-01T00:00:00Z')).state).toBe('approved_not_effective');
    expect(effectiveLegalDocument('aramo.privacy_notice', [...LEGAL_DOCUMENTS, noUrl], at('2030-01-01T00:00:00Z'))).toBe(v10);
  });

  it('a DRAFT is never effective, even with a past effective_from', () => {
    const draft: LegalDocumentVersion = { ...v11, status: 'DRAFT', effective_from: '2026-01-01T00:00:00Z' };
    expect(legalVersionStatus(draft, [...LEGAL_DOCUMENTS, draft]).state).toBe('draft');
    expect(effectiveLegalDocument('aramo.privacy_notice', [...LEGAL_DOCUMENTS, draft])).toBe(v10);
  });

  it('position does not decide the current version; same-instant ties go to the later entry', () => {
    const r = [...LEGAL_DOCUMENTS, v12, v11];
    expect(effectiveLegalDocument('aramo.privacy_notice', r, at('2026-12-01T00:00:00Z'))).toBe(v11);
    const tie: LegalDocumentVersion = { ...v11, version: '1.1.1' };
    expect(effectiveLegalDocument('aramo.privacy_notice', [...reg, tie], at('2026-12-01T00:00:00Z'))).toBe(tie);
  });

  it('before any version is effective nothing is current', () => {
    expect(effectiveLegalDocument('aramo.privacy_notice', reg, at('2026-10-20T23:59:59Z'))).toBeNull();
    expect(state(v10, '2026-10-20T23:59:59Z')).toBe('upcoming');
  });
});
