import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TITLES,
  PERSONAL_LEGAL_DOCUMENT_KEYS,
  approvedLegalDocument,
  legalRef,
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
    const approved: LegalDocumentVersion = { ...LEGAL_DOCUMENTS[0]!, version: '1.0.0', status: 'APPROVED', url: 'https://aramo.ai/legal/sign/terms/1.0.0' };
    const reg = [...LEGAL_DOCUMENTS, approved];
    expect(approvedLegalDocument('sign.terms_of_service', reg)).toBe(approved);
    expect(legalRef(approved)).toBe(`sign.terms_of_service@1.0.0#${approved.sha256}`);
    expect(approvedLegalDocument('sign.terms_of_service', [{ ...approved, url: null }])).toBeNull();
  });
});
