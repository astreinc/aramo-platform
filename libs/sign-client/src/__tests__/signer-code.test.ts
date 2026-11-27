// SIGN-FREE-PARITY-1 S3 — runs under vitest and mobile Jest (globals only). The signer's
// one-time code: the screen says plainly where the code goes; one set of words for both clients.
import {
  EMAIL_CODE_OPTION,
  SIGNER_CODE_COPY,
  SIGNER_CODE_ROUTE,
  signerCodeMethodOf,
  signerCodeSendRefusal,
  signerCodeVerifyRefusal,
} from '../index.js';

describe('signer one-time code (SMS or email)', () => {
  it('reads the method the server names; anything else is the SMS code', () => {
    expect(signerCodeMethodOf('EMAIL_OTP')).toBe('EMAIL_OTP');
    expect(signerCodeMethodOf('SMS_OTP')).toBe('SMS_OTP');
    expect(signerCodeMethodOf(undefined)).toBe('SMS_OTP');
    expect(signerCodeMethodOf('email')).toBe('SMS_OTP');
  });

  it('routes each method to its own send / verify pair', () => {
    expect(SIGNER_CODE_ROUTE).toEqual({ SMS_OTP: 'sms-otp', EMAIL_OTP: 'email-otp' });
  });

  it('the email screen says the code goes to the signer’s email', () => {
    const c = SIGNER_CODE_COPY.EMAIL_OTP;
    expect(c.title).toBe('Enter the code we email you');
    expect(c.body('j***@example.com')).toContain('email a 6-digit code to j***@example.com');
    expect(c.sentBody('j***@example.com')).toContain('We sent a 6-digit code to j***@example.com');
    expect(c.body(null)).toContain('your email');
    expect(c.sendLabel).toBe('Email me a code');
    expect(EMAIL_CODE_OPTION.label).toBe('Ask for a code sent to their email before signing');
  });

  it('keeps the SMS screen words', () => {
    expect(SIGNER_CODE_COPY.SMS_OTP.title).toBe('Enter the code we text you');
    expect(SIGNER_CODE_COPY.SMS_OTP.sendLabel).toBe('Text me a code');
  });

  it('maps refusals by reason, with a plain fallback (never the server text)', () => {
    expect(signerCodeSendRefusal('otp_resend_cooldown')).toBe('Wait a minute before asking for another code.');
    expect(signerCodeSendRefusal('anything')).toBe('The code couldn’t be sent. Try again in a moment.');
    expect(signerCodeVerifyRefusal('otp_mismatch')).toBe('That code isn’t right. Check it and try again.');
    expect(signerCodeVerifyRefusal(undefined)).toBe('That didn’t go through. Try again.');
  });
});
