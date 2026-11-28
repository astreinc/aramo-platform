// SIGN-FREE-PARITY-1 S2 — the sender's own phone step-up (runs under vitest and mobile Jest).
import { PHONE_STEP_UP_COPY, isStepUpCode, normalizeStepUpCode, offersPhoneStepUp, refusalMessage } from '../index.js';

describe('offersPhoneStepUp', () => {
  const on = { available: true, required: true, phone_masked: '+1••••••••67' };

  it('offers the verify screen only for the phone refusal while self-serve is on and a step is owed', () => {
    expect(offersPhoneStepUp('phone_verification_required', on)).toBe(true);
    expect(offersPhoneStepUp('personal_review_pending', on)).toBe(false);
    expect(offersPhoneStepUp('phone_verification_required', { ...on, available: false })).toBe(false);
    expect(offersPhoneStepUp('phone_verification_required', { ...on, required: false })).toBe(false);
    expect(offersPhoneStepUp('phone_verification_required', null)).toBe(false);
  });

  it('switch off keeps today’s plain message', () => {
    expect(refusalMessage({ code: 'INSUFFICIENT_PERMISSIONS', reason: 'phone_verification_required', status: 403 })).toBe('Verify your phone number to send.');
  });
});

describe('step-up code', () => {
  it('keeps digits only, at most 6', () => {
    expect(normalizeStepUpCode(' 12-34 567')).toBe('123456');
    expect(isStepUpCode('123456')).toBe(true);
    expect(isStepUpCode('12345')).toBe(false);
    expect(isStepUpCode('12345a')).toBe(false);
  });
});

describe('copy', () => {
  it('names the masked number and the refusals have plain copy', () => {
    expect(PHONE_STEP_UP_COPY.sentTo('+1••••••••67')).toBe('We texted a code to +1••••••••67. It expires in 10 minutes.');
    // SMS-OPTIN-1 — the 10DLC opt-in disclosure (rates + STOP).
    expect(PHONE_STEP_UP_COPY.smsDisclosure).toContain('Msg & data rates may apply');
    expect(PHONE_STEP_UP_COPY.smsDisclosure).toContain('Reply STOP to opt out');
    expect(refusalMessage({ code: 'VALIDATION_ERROR', reason: 'personal_code_rate_limited', status: 400 })).toBe('Wait a minute before asking for another code.');
    expect(refusalMessage({ code: 'ESIGN_SEND_UNAVAILABLE', reason: 'step_up_sms_not_sent', status: 503 })).toBe('We couldn’t send the text. Try again in a few minutes.');
    expect(refusalMessage({ code: 'VALIDATION_ERROR', reason: 'phone_in_use', status: 400 })).toBe('This number is already used by another account. Use a different number.');
  });
});
