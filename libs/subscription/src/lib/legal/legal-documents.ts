// Commercial Plans Amendment A1 §3 — the versioned Aramo Sign legal documents.
// The texts live in doc/legal/aramo-sign/*.md; this registry pins each version to
// the SHA-256 of its file (a spec fails if a text changes without a new version),
// so every acceptance record names the exact text that was accepted.
//
// Nothing is APPROVED. A document becomes APPROVED only by a governed change to
// this registry after legal review and PO approval; until then:
//   - signup shows no terms checkbox and records no acceptance,
//   - checkout records no terms acceptance,
//   - a LIVE-mode checkout is refused (no live charging without approved terms).

export type LegalDocumentKey = 'sign.terms_of_service' | 'sign.privacy_policy' | 'sign.esign_consent_disclosure' | 'sign.retention_policy';

export interface LegalDocumentVersion {
  key: LegalDocumentKey;
  version: string;
  status: 'DRAFT' | 'APPROVED';
  path: string;
  sha256: string;
  // Public URL of the published text (only for an APPROVED version).
  url: string | null;
}

export const LEGAL_DOCUMENTS: readonly LegalDocumentVersion[] = [
  {
    key: 'sign.terms_of_service',
    version: '0.1.1',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/terms-of-service.md',
    sha256: '2c2ccb95a13137700c8f80935f001e3548060e04eb3750949eeb11352073688b',
    url: null,
  },
  {
    key: 'sign.privacy_policy',
    version: '0.1.0',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/privacy-policy.md',
    sha256: 'dde882abe64e0719ee6c60319c6c281707b2689a31f301f780ec211b4111f7a3',
    url: null,
  },
  {
    key: 'sign.esign_consent_disclosure',
    version: '0.1.0',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/esign-consent-disclosure.md',
    sha256: '36fe43c7be67a0ecc392577785a8f686c57b5f95a53195174323e3d237ce091b',
    url: null,
  },
  {
    key: 'sign.retention_policy',
    version: '0.1.0',
    status: 'DRAFT',
    path: 'doc/legal/aramo-sign/retention-export-deletion-policy.md',
    sha256: '83248530dfba08dfdd19f5bddc4e9318833270f550d1b69ff8e0061a5d2f4a7b',
    url: null,
  },
];

export const LEGAL_DOCUMENT_REGISTRY = 'LEGAL_DOCUMENT_REGISTRY';

/** The latest APPROVED version of a document, or null while none is approved. */
export function approvedLegalDocument(key: LegalDocumentKey, registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS): LegalDocumentVersion | null {
  const approved = registry.filter((d) => d.key === key && d.status === 'APPROVED' && d.url !== null);
  return approved.length === 0 ? null : approved[approved.length - 1]!;
}

/** The reference stored with an acceptance: key@version#sha256. */
export function legalRef(d: LegalDocumentVersion): string {
  return `${d.key}@${d.version}#${d.sha256}`;
}
