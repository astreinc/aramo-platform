import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENTS, approvedLegalDocument, legalRef, type LegalDocumentVersion } from '../lib/legal/legal-documents.js';

// Commercial Plans Amendment A1 §3 — legal texts are versioned and pinned: a text
// change without a new version fails here; nothing is approved; a draft is never
// offered for acceptance.

const ROOT = resolve(__dirname, '../../../..');

describe('legal document registry', () => {
  it.each(LEGAL_DOCUMENTS.map((d) => [d.key, d] as const))('%s: the pinned sha256 is the file on disk', (_k, d) => {
    const text = readFileSync(resolve(ROOT, d.path));
    expect(createHash('sha256').update(text).digest('hex')).toBe(d.sha256);
  });

  it('every document is a DRAFT marked legal-pending in its own text', () => {
    for (const d of LEGAL_DOCUMENTS) {
      expect(d.status).toBe('DRAFT');
      expect(d.url).toBeNull();
      expect(readFileSync(resolve(ROOT, d.path), 'utf8')).toContain('DRAFT — LEGAL-PENDING');
    }
  });

  it('no approved version exists, so none can be offered for acceptance', () => {
    for (const d of LEGAL_DOCUMENTS) expect(approvedLegalDocument(d.key)).toBeNull();
  });

  it('an approved version (with a published URL) is offered and referenced exactly', () => {
    const approved: LegalDocumentVersion = { ...LEGAL_DOCUMENTS[0]!, version: '1.0.0', status: 'APPROVED', url: 'https://aramo.ai/legal/sign/terms/1.0.0' };
    const reg = [...LEGAL_DOCUMENTS, approved];
    expect(approvedLegalDocument('sign.terms_of_service', reg)).toBe(approved);
    expect(legalRef(approved)).toBe(`sign.terms_of_service@1.0.0#${approved.sha256}`);
    expect(approvedLegalDocument('sign.terms_of_service', [{ ...approved, url: null }])).toBeNull();
  });
});
