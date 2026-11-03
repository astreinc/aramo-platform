// Ported from apps/sign-web personal-signup-api.ts (M-A11 §4): same phone rules and the same
// closed set of start refusals, rendered with native copy (never server prose).
import { ApiError } from '../../../api/errors';
import {
  codeFailureMessage,
  fieldMessage,
  isGmail,
  SIGNUP_COPY,
  startFailure,
  startFailureMessage,
  toE164,
  validateDetails,
} from '../signupModel';

const err = (status: number, reason: string, details: Record<string, unknown> = {}) =>
  new ApiError({ status, code: 'VALIDATION_ERROR', reason, details: { reason, ...details } });

describe('toE164', () => {
  it('US and India mobile numbers', () => {
    expect(toE164('US', '(415) 555-0100')).toBe('+14155550100');
    expect(toE164('US', '1 415 555 0100')).toBe('+14155550100');
    expect(toE164('US', '115 555 0100')).toBeNull();
    expect(toE164('IN', '98765 43210')).toBe('+919876543210');
    expect(toE164('IN', '+91 98765 43210')).toBe('+919876543210');
    expect(toE164('IN', '098765 43210')).toBe('+919876543210');
    expect(toE164('IN', '58765 43210')).toBeNull();
  });
});

describe('start refusals', () => {
  it('maps every contract reason', () => {
    expect(startFailure(err(404, 'NOT_FOUND')).kind).toBe('not_open');
    expect(startFailure(err(429, 'x')).kind).toBe('rate_limited');
    expect(startFailure(err(400, 'business_email_use_business_signup')).kind).toBe(
      'business_email',
    );
    expect(startFailure(err(400, 'personal_email_not_allowed')).kind).toBe('disposable');
    expect(startFailure(err(400, 'personal_location_not_supported')).kind).toBe('location');
    expect(startFailure(err(400, 'personal_signup_refused')).kind).toBe('refused');
    expect(startFailure(err(400, 'personal_pilot_full')).kind).toBe('pilot_full');
    expect(startFailure(err(400, 'invite_required')).kind).toBe('invite_required');
    expect(startFailure(err(400, 'invite_invalid')).kind).toBe('invite_invalid');
    expect(startFailure(err(400, 'VALIDATION_ERROR', { field: 'phone' }))).toEqual({
      kind: 'field',
      field: 'phone',
    });
    expect(startFailure(err(400, 'something_new')).kind).toBe('other');
  });

  it('renders native copy for each (refused and not_open are screens, not messages)', () => {
    expect(startFailureMessage({ kind: 'business_email' })).toBe(SIGNUP_COPY.businessEmail);
    expect(startFailureMessage({ kind: 'disposable' })).toBe(SIGNUP_COPY.disposable);
    expect(startFailureMessage({ kind: 'location' })).toBe(SIGNUP_COPY.location);
    expect(startFailureMessage({ kind: 'pilot_full' })).toBe(SIGNUP_COPY.pilotFull);
    expect(startFailureMessage({ kind: 'rate_limited' })).toBe(SIGNUP_COPY.rateLimited);
    expect(startFailureMessage({ kind: 'refused' })).toBeNull();
    expect(startFailureMessage({ kind: 'not_open' })).toBeNull();
    expect(startFailureMessage({ kind: 'other' })).toBe(SIGNUP_COPY.generic);
    expect(fieldMessage('client', 'US')).toBeNull();
    expect(fieldMessage('phone', 'IN')).toBe('Enter a 10-digit Indian mobile number.');
  });
});

describe('code refusals', () => {
  it('expired signup, rate limit, lockout, expired code, attempts left', () => {
    expect(codeFailureMessage(err(404, 'NOT_FOUND'))).toEqual({
      message: 'This signup has expired. Start again.',
      restart: true,
    });
    expect(codeFailureMessage(err(429, 'x')).restart).toBe(false);
    expect(codeFailureMessage(err(400, 'personal_code_rate_limited')).message).toBe(
      'Too many tries. Wait a minute and try again.',
    );
    expect(codeFailureMessage(err(400, 'code_attempts_exceeded')).restart).toBe(true);
    expect(codeFailureMessage(err(400, 'code_expired')).message).toBe(
      'This code has expired. Send a new code.',
    );
    expect(codeFailureMessage(err(400, 'code_invalid', { attempts_remaining: 1 })).message).toBe(
      'That code isn’t right. 1 try left.',
    );
    expect(codeFailureMessage(err(400, 'code_invalid')).message).toBe(
      'That code isn’t right. Check the code and try again.',
    );
  });
});

describe('details', () => {
  it('validates before start and detects Gmail addresses', () => {
    const { errors, e164 } = validateDetails({
      name: 'P',
      email: 'nope',
      country: 'US',
      phone: '12',
      residence: '',
      invite: '',
      inviteRequired: true,
    });
    expect(Object.keys(errors).sort()).toEqual(['email', 'invite', 'name', 'phone', 'residence']);
    expect(e164).toBeNull();
    expect(isGmail('Pat.Lee@GMAIL.com')).toBe(true);
    expect(isGmail('pat@googlemail.com')).toBe(true);
    expect(isGmail('pat@outlook.com')).toBe(false);
  });
});
