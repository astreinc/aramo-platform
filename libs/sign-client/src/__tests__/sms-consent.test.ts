// SMS-CONSENT-1 — the shared consent wording, the signer code text and the refusal copy (runs under
// vitest and mobile Jest).
import {
  SIGNER_SMS_CODE_TEXT,
  SMS_CERTIFICATION_WORDING,
  SMS_CERTIFICATION_WORDING_VERSION,
  SMS_CONSENT_COPY,
  SMS_CONSENT_NOT_CERTIFIED_REASON,
  SMS_CONSENT_REFUSAL_COPY,
  SMS_CONSENT_WORDING,
  SMS_CONSENT_WORDING_VERSION,
  SMS_NOT_CERTIFIED_NOTE,
  SMS_NOT_IN_PLAN_REASON,
  isSmsConsentChannel,
  refusalMessage,
  signerSmsCodeText,
  smsSendOptionsState,
} from '../index.js';

describe('SMS-CONSENT-1 wording', () => {
  it('carries the LOCKED wording and its versions verbatim', () => {
    expect(SMS_CERTIFICATION_WORDING).toBe(
      'I certify, on behalf of my organization, that we obtain each recipient’s consent before we send them text messages through Aramo Sign, and that we stop texting anyone who asks us to.',
    );
    expect(SMS_CONSENT_WORDING).toBe(
      'Let people who send me documents through Aramo Sign text me signing requests, reminders and signing codes. Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
    );
    expect(SMS_CERTIFICATION_WORDING_VERSION).toBe('2026-11-28');
    expect(SMS_CONSENT_WORDING_VERSION).toBe('2026-11-28');
    expect(SMS_CONSENT_COPY.consentLabel).toBe(SMS_CONSENT_WORDING);
  });

  it('R-6 the signer code text names the code and the minutes and ends with STOP', () => {
    expect(signerSmsCodeText('123456', 10)).toBe('Your Aramo Sign verification code is 123456. It expires in 10 minutes. Do not share it. Reply STOP to opt out.');
    expect(SIGNER_SMS_CODE_TEXT.endsWith('Reply STOP to opt out.')).toBe(true);
  });

  it('the consent channels are WEB, APP and SIGNUP', () => {
    expect(isSmsConsentChannel('WEB')).toBe(true);
    expect(isSmsConsentChannel('APP')).toBe(true);
    expect(isSmsConsentChannel('SIGNUP')).toBe(true);
    expect(isSmsConsentChannel('EMAIL')).toBe(false);
    expect(isSmsConsentChannel(undefined)).toBe(false);
  });
});

describe('SMS-CONSENT-1 refusals', () => {
  it('the two signer SMS refusals have their own copy, through refusalMessage', () => {
    expect(SMS_NOT_IN_PLAN_REASON).toBe('sms_not_in_plan');
    expect(SMS_CONSENT_NOT_CERTIFIED_REASON).toBe('sms_consent_not_certified');
    expect(refusalMessage({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', status: 403, details: { reason: 'sms_not_in_plan', feature_key: 'sign.sms_delivery' } })).toBe(
      SMS_CONSENT_REFUSAL_COPY['sms_not_in_plan'],
    );
    expect(refusalMessage({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', status: 403, details: { reason: 'sms_consent_not_certified' } })).toBe(SMS_NOT_CERTIFIED_NOTE);
    expect(SMS_NOT_CERTIFIED_NOTE).toBe('An administrator must confirm SMS consent in Settings before texts can be sent.');
  });

  it('every refusal has plain words', () => {
    for (const [reason, text] of Object.entries(SMS_CONSENT_REFUSAL_COPY)) {
      expect(reason).toMatch(/^sms_/);
      expect(text.length).toBeGreaterThan(0);
      expect(refusalMessage({ code: 'VALIDATION_ERROR', status: 400, details: { reason } })).toBe(text);
    }
  });
});

describe('smsSendOptionsState', () => {
  it('offered when the server reports a text option on', () => {
    expect(smsSendOptionsState({ sms_delivery: true, sms_otp: false }, { required: true, certified: true })).toBe('offered');
    expect(smsSendOptionsState({ sms_delivery: false, sms_otp: true }, null)).toBe('offered');
  });

  it('the note when certification is required and missing', () => {
    expect(smsSendOptionsState({ sms_delivery: false, sms_otp: false }, { required: true, certified: false })).toBe('needs_certification');
  });

  it('hidden otherwise (dark, not in the plan, an older server)', () => {
    expect(smsSendOptionsState({ sms_delivery: false, sms_otp: false }, { required: false, certified: false })).toBe('hidden');
    expect(smsSendOptionsState(undefined, undefined)).toBe('hidden');
  });
});
