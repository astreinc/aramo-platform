// SMS-CONSENT-1 §2 (R-3) — the optional "Get signing requests by text" step after signup.
// The signup done step marks this browser; after the first sign-in the workspace shows the
// step once (pages/TextMessages.tsx SmsSignupStep), and only while texts are available.
// Storage can be blocked (private windows): then the optional step is simply not shown.

export const SMS_SIGNUP_OFFER_KEY = 'aramo.sign.sms-signup-offer';

export function markSmsSignupOffer(): void {
  try {
    window.localStorage.setItem(SMS_SIGNUP_OFFER_KEY, '1');
  } catch {
    // Storage blocked: the step is optional, so nothing is shown later.
  }
}

export function smsSignupOfferPending(): boolean {
  try {
    return window.localStorage.getItem(SMS_SIGNUP_OFFER_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearSmsSignupOffer(): void {
  try {
    window.localStorage.removeItem(SMS_SIGNUP_OFFER_KEY);
  } catch {
    // Nothing to clear.
  }
}
