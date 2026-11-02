import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '../../lib/legal/legal-documents.js';

/**
 * TEST ONLY — the shipped legal registry as it was before Aramo Sign Terms of Service v2.0 was
 * registered (v2.0 takes effect 2026-11-02 12:00 EST). Billing / commercial specs that exercise
 * checkout, self-service and terms gating pass this registry so their outcome does not depend on
 * the wall clock relative to that instant; the ToS v2.0 behaviour itself is covered by the legal
 * specs with an injected clock.
 */
export const LEGAL_DOCUMENTS_BEFORE_TOS_V20: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS.filter(
  (d) => !(d.key === 'sign.terms_of_service' && d.version === '2.0'),
);
