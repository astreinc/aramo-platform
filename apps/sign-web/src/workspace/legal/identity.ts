// Aramo-Sign-Mobile-Amendment-M-A7 §5.1 (R-8, G-6) — the ONE identity block of
// Aramo Sign on the web: the developer and legal entity, its postal address and
// the support and privacy contacts. Every value is copied verbatim from the
// published Aramo Privacy Notice 1.0 §17 (doc/legal/aramo/privacy-notice.md),
// and legal.spec.tsx asserts it still appears there, so the help page, the legal
// pages and the Privacy Notice never disagree. The mobile app carries the same
// block (mobile/sign/src/config/identity.ts), pinned to the same text.
export const ARAMO_SIGN_IDENTITY = {
  /** The developer and operator of Aramo Sign (the legal entity). */
  legalEntity: 'Astre Consulting Services Inc',
  /** The entity's registered postal address. */
  postalAddress: '2909 Gettysburg Sq, Vienna, VA 22181, USA',
  supportEmail: 'support@aramo.ai',
  privacyEmail: 'privacy@aramo.ai',
} as const;

export const HELP_PATH = '/help';
export const LEGAL_INDEX_PATH = '/legal';
export const TERMS_INDEX_PATH = '/legal/terms';
