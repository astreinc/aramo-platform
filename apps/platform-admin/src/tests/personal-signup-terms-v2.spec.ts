import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '@aramo/subscription';

import { PERSONAL_LEGAL_KEYS, PersonalSignupService } from '../app/signup/personal-signup.service.js';
import { SignSignupService } from '../app/signup/sign-signup.service.js';

// ToS v2.0 (PO 2026-11-01) — the Personal signup presents the documents in effect per key:
// the Personal Terms 1.0 while sign.terms_of_service 2.0 is not effective, v2.0 once it is.
// currentTerms() reads only the registry, so the service is built without its collaborators.

function signup(registry: readonly LegalDocumentVersion[]): PersonalSignupService {
  const svc = Object.create(PersonalSignupService.prototype) as PersonalSignupService;
  (svc as unknown as { legal: readonly LegalDocumentVersion[] }).legal = registry;
  return svc;
}

const v20 = LEGAL_DOCUMENTS.find((d) => d.key === 'sign.terms_of_service' && d.version === '2.0')!;
// ToS v2.0 takes effect at 2026-11-01 23:00 EST in the shipped registry (injected clock, never wall time).
const scheduled = LEGAL_DOCUMENTS;
const BEFORE = new Date('2026-11-01T22:59:59.999-05:00');
const AT = new Date('2026-11-01T23:00:00-05:00');

describe('Personal signup terms — ToS v2.0', () => {
  it('uses the registry keys, with sign.terms_of_service as the terms key', () => {
    expect([...PERSONAL_LEGAL_KEYS]).toEqual(['sign.terms_of_service', 'aramo.privacy_notice', 'aramo.acceptable_use_policy']);
  });

  it('the shipped registry before 23:00 EST: the Personal Terms 1.0, Privacy Notice 1.0 and AUP 1.0 are presented', () => {
    expect(signup(LEGAL_DOCUMENTS).currentTerms(BEFORE)!.map((d) => `${d.key}@${d.version}`)).toEqual([
      'sign.personal_terms_of_service@1.0',
      'aramo.privacy_notice@1.0',
      'aramo.acceptable_use_policy@1.0',
    ]);
  });

  it('once v2.0 is effective it is presented instead of the Personal Terms', () => {
    const terms = signup(scheduled).currentTerms(AT)!;
    expect(terms[0]).toEqual({ key: 'sign.terms_of_service', version: '2.0', url: 'https://sign.aramo.ai/legal/terms-of-service/2.0', sha256: v20.sha256 });
    expect(signup(scheduled).currentTerms(BEFORE)![0]!.key).toBe('sign.personal_terms_of_service');
  });
});

// Business signup (unchanged code) reads sign.terms_of_service from the same registry: while v2.0
// is not effective it demands no terms, exactly as before v2.0 was registered.
function business(registry: readonly LegalDocumentVersion[]): SignSignupService {
  const svc = Object.create(SignSignupService.prototype) as SignSignupService;
  (svc as unknown as { legal: readonly LegalDocumentVersion[] }).legal = registry;
  return svc;
}

describe('Business signup terms — ToS v2.0', () => {
  it('the shipped registry before 23:00 EST: no terms are presented or required', () => {
    expect(business(LEGAL_DOCUMENTS).currentTerms(BEFORE)).toBeNull();
    expect(business(LEGAL_DOCUMENTS.filter((d) => d !== v20)).currentTerms(AT)).toBeNull();
  });

  it('once v2.0 is effective, Business signup presents and requires it', () => {
    expect(business(scheduled).currentTerms(AT)).toEqual({ version: '2.0', url: 'https://sign.aramo.ai/legal/terms-of-service/2.0' });
  });
});
