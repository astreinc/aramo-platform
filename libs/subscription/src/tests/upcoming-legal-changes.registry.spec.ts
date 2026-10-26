import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '../lib/legal/legal-documents.js';
import { RegistryUpcomingLegalChangeSource } from '../lib/legal/upcoming-legal-changes.js';

// E-5 ↔ E-6 binding: the banner's upcoming changes come from the registry's 'upcoming' state.

const base = LEGAL_DOCUMENTS.find((d) => d.key === 'aramo.privacy_notice' && d.version === '1.0')!;
const v11 = (over: Partial<LegalDocumentVersion> = {}): LegalDocumentVersion => ({
  ...base,
  version: '1.1',
  path: 'doc/legal/aramo/privacy-notice-1.1.md',
  sha256: 'f'.repeat(64),
  url: 'https://sign.aramo.ai/legal/privacy/1.1',
  status: 'APPROVED',
  effective_from: '2026-11-25T00:00:00Z',
  ...over,
});
const at = (iso: string) => () => new Date(iso);

describe('RegistryUpcomingLegalChangeSource', () => {
  it('announces nothing for the shipped registry (no version is upcoming)', () => {
    expect(new RegistryUpcomingLegalChangeSource(LEGAL_DOCUMENTS, at('2026-10-27T00:00:00Z'), []).announced()).toEqual([]);
  });

  it('announces an APPROVED, published version with a future effective_from', () => {
    const reg = [...LEGAL_DOCUMENTS, v11()];
    expect(new RegistryUpcomingLegalChangeSource(reg, at('2026-10-27T00:00:00Z'), []).announced()).toEqual([
      { key: 'aramo.privacy_notice', version: '1.1', effective_date: '2026-11-25' },
    ]);
  });

  it('stops announcing it once it is effective (inclusive at the instant)', () => {
    const reg = [...LEGAL_DOCUMENTS, v11()];
    expect(new RegistryUpcomingLegalChangeSource(reg, at('2026-11-25T00:00:00Z'), []).announced()).toEqual([]);
  });

  it('never announces a DRAFT, an unpublished or an unscheduled version', () => {
    for (const over of [{ status: 'DRAFT' as const }, { url: null }, { effective_from: null }]) {
      const reg = [...LEGAL_DOCUMENTS, v11(over)];
      expect(new RegistryUpcomingLegalChangeSource(reg, at('2026-10-27T00:00:00Z'), []).announced()).toEqual([]);
    }
  });

  it('merges the governed static list without duplicates (registry wins)', () => {
    const reg = [...LEGAL_DOCUMENTS, v11()];
    const extra = [{ key: 'aramo.privacy_notice' as const, version: '1.1', effective_date: '2026-12-01' }];
    expect(new RegistryUpcomingLegalChangeSource(reg, at('2026-10-27T00:00:00Z'), extra).announced()).toEqual([
      { key: 'aramo.privacy_notice', version: '1.1', effective_date: '2026-11-25' },
    ]);
  });
});
