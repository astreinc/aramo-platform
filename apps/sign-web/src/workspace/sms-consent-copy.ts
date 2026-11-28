// SMS-CONSENT-1 — the consent wording and screen words live once in @aramo/sign-client (one copy for
// sign-service, Sign web and the app); this module only gives the screens their local names.
import { SMS_CONSENT_COPY, SMS_NOT_CERTIFIED_NOTE } from '@aramo/sign-client';

export {
  SMS_CERTIFICATION_WORDING,
  SMS_CERTIFICATION_WORDING_VERSION,
  SMS_CONSENT_WORDING,
  SMS_CONSENT_WORDING_VERSION,
} from '@aramo/sign-client';

/** The send flow, when text options are launched and in the plan but not yet certified. */
export const SMS_SEND_NOTE = SMS_NOT_CERTIFIED_NOTE;

/** The optional step after signup (R-3). */
export const SMS_SIGNUP_STEP_TITLE = SMS_CONSENT_COPY.signupTitle;
export const SMS_SIGNUP_STEP_SKIP = SMS_CONSENT_COPY.skip;
