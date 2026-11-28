// SMS-CONSENT-1 §2 — the words of the SMS consent screens in the Aramo Sign app.
//
// TEMPORARY: to be replaced by the @aramo/sign-client exports at integration
// (libs/sign-client/src/lib/sms-consent.ts). The wording and versions below must match the
// shared module exactly; the server also returns the wording it records (`wording`,
// `wording_version`) and the screens show the server's when it is there.

/** The organization certification an owner or admin confirms once (R-2; web only). */
export const SMS_CERTIFICATION_WORDING_VERSION = '2026-11-28';
export const SMS_CERTIFICATION_WORDING =
  "I certify, on behalf of my organization, that we obtain each recipient's consent before we send them text messages through Aramo Sign, and that we stop texting anyone who asks us to.";

/** A registered user's own opt-in (R-3): a separate box, never ticked for them. */
export const SMS_CONSENT_WORDING_VERSION = '2026-11-28';
export const SMS_CONSENT_WORDING =
  'Let people who send me documents through Aramo Sign text me signing requests, reminders and signing codes. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';

/** The send flow, when text options are launched and in the plan but not yet certified. */
export const SMS_SEND_NOTE =
  'An administrator must confirm SMS consent in Settings before texts can be sent.';

/** The optional step after signup (R-3). */
export const SMS_SIGNUP_STEP_TITLE = 'Get signing requests by text';
export const SMS_SIGNUP_STEP_SKIP = 'Not now';
