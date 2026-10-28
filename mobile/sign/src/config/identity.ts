// Aramo-Sign-Mobile-Amendment-M-A7 §5.1 (R-8, G-6) — the ONE identity block of the
// Aramo Sign app (Account → About): the developer and legal entity, its postal
// address and the support and privacy contacts. Every value is copied verbatim from
// the published Aramo Privacy Notice 1.0 §17 (doc/legal/aramo/privacy-notice.md);
// config/__tests__/identity.test.ts pins it to that text, and sign-web carries the
// same block (apps/sign-web/src/workspace/legal/identity.ts), so the app, the help
// page and the Privacy Notice never disagree. The Play listing uses the same values.
export const ARAMO_SIGN_IDENTITY = {
  /** The developer and operator of Aramo Sign (the legal entity). */
  legalEntity: 'Astre Consulting Services Inc',
  /** The entity's registered postal address. */
  postalAddress: '2909 Gettysburg Sq, Vienna, VA 22181, USA',
  supportEmail: 'support@aramo.ai',
  privacyEmail: 'privacy@aramo.ai',
} as const;

export const SUPPORT_MAILTO = `mailto:${ARAMO_SIGN_IDENTITY.supportEmail}`;
export const PRIVACY_MAILTO = `mailto:${ARAMO_SIGN_IDENTITY.privacyEmail}`;
