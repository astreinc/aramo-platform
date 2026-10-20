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

// Commercial Plans Amendment A1 §3.C — the consent disclosure drafted from the
// Lead Architect's framework (doc/legal/aramo-sign/esign-consent-disclosure.md,
// a spec keeps both copies identical). LEGAL_PENDING: not served unless
// SIGN_DISCLOSURE_VERSION=v2 is set, which is a separately authorized step.
export const DISCLOSURE_V2_TEXT = [
  'Agreement to Use Electronic Records and Signatures',
  'By affirmatively selecting "I agree to use electronic records and signatures", you consent to using electronic records and signatures for the document transaction presented to you, where permitted by applicable law.',
  [
    'You acknowledge that:',
    '1. The document will be presented electronically for your review.',
    '2. Your electronic signature is intended to represent your agreement or other stated signing intention.',
    '3. Electronic records may be made available to the document sender and other authorized parties.',
    '4. You may access or obtain a copy of the signed document, subject to applicable access arrangements.',
    '5. You may decline to sign electronically. Where applicable, the sender can explain available alternatives.',
    '6. Instructions for withdrawing consent, requesting paper records and updating contact information will be provided where required.',
  ].join('\n'),
].join('\n\n');

const DISCLOSURES: readonly DisclosureVersion[] = [
  version('v1', 'By continuing you consent to sign this document electronically.', 'LEGAL_PENDING'),
  version('v2', DISCLOSURE_V2_TEXT, 'LEGAL_PENDING'),
];

// The version served to signers by default. SIGN_DISCLOSURE_VERSION selects a
// registered version (an unknown value falls back here, never to nothing).
export const CURRENT_DISCLOSURE_VERSION = 'v1';

export function currentDisclosure(env: NodeJS.ProcessEnv = process.env): DisclosureVersion {
  const selected = env['SIGN_DISCLOSURE_VERSION']?.trim();
  return DISCLOSURES.find((d) => d.version === selected) ?? DISCLOSURES.find((d) => d.version === CURRENT_DISCLOSURE_VERSION)!;
}

export function listDisclosures(): readonly DisclosureVersion[] {
  return DISCLOSURES;
}

export function findDisclosure(versionId: string): DisclosureVersion | undefined {
  return DISCLOSURES.find((d) => d.version === versionId);
}
