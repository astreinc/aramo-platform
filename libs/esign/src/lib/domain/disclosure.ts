import { createHash } from 'node:crypto';

// A-7 / Aramo Sign launch — the electronic-records-and-signature disclosure is
// SERVER-HELD and versioned. The signer app fetches the current version's text and
// hash from E-Sign and sends both back on acceptance; acceptance of an unknown
// version or a mismatching hash is refused. The certificate therefore records
// exactly which text the signer agreed to.
//
// LEGAL STATUS: v1 is the text shown since DOC-4. The final consumer disclosure is
// a Legal deliverable (launch decision D-10). Publishing a Legal-approved text
// means ADDING a new version here (never editing v1, which existing acceptances
// reference) and pointing CURRENT_DISCLOSURE_VERSION at it.

export interface DisclosureVersion {
  version: string;
  text: string;
  text_sha256: string;
  legal_status: 'LEGAL_PENDING' | 'LEGAL_APPROVED';
}

function version(v: string, text: string, legal_status: DisclosureVersion['legal_status']): DisclosureVersion {
  return { version: v, text, text_sha256: createHash('sha256').update(text, 'utf8').digest('hex'), legal_status };
}

const DISCLOSURES: readonly DisclosureVersion[] = [
  version('v1', 'By continuing you consent to sign this document electronically.', 'LEGAL_PENDING'),
];

export const CURRENT_DISCLOSURE_VERSION = 'v1';

export function currentDisclosure(): DisclosureVersion {
  return DISCLOSURES.find((d) => d.version === CURRENT_DISCLOSURE_VERSION)!;
}

export function findDisclosure(versionId: string): DisclosureVersion | undefined {
  return DISCLOSURES.find((d) => d.version === versionId);
}
