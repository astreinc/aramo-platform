// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit rows 6, 18–24, 26–28 (Appendix A: the server's enforced value is canonical).
import {
  ACCESS_CODE_MAX_LENGTH,
  ACCESS_CODE_MIN_LENGTH,
  CHECKBOX_GROUP_KEY_MAX,
  CHECKBOX_LABEL_MAX,
  DELEGATE_REASON_MAX,
  E164_PATTERN,
  EMAIL_MAX,
  ENVELOPE_MESSAGE_MAX,
  ENVELOPE_SUBJECT_MAX,
  MAX_COPY_RECIPIENTS,
  MAX_SIGNERS,
  SIGNERS_FULL_MESSAGE,
  VOID_REASON_MAX,
  isE164,
  isValidAccessCode,
  isValidDeclineReason,
  isValidDelegate,
  isValidEmail,
  normalizeAccessCode,
  voidReasonProblem,
} from '../index.js';

describe('limits (rows 18–21, 26, 6, 28)', () => {
  it.each([
    ['subject', ENVELOPE_SUBJECT_MAX, 200],
    ['message', ENVELOPE_MESSAGE_MAX, 1000],
    ['signers', MAX_SIGNERS, 10],
    ['copy recipients', MAX_COPY_RECIPIENTS, 10],
    ['email', EMAIL_MAX, 254],
    ['access code min', ACCESS_CODE_MIN_LENGTH, 4],
    ['access code max', ACCESS_CODE_MAX_LENGTH, 32],
    ['checkbox label', CHECKBOX_LABEL_MAX, 200],
    ['checkbox group key', CHECKBOX_GROUP_KEY_MAX, 64],
    ['void reason', VOID_REASON_MAX, 500],
    ['delegate reason', DELEGATE_REASON_MAX, 500],
  ])('%s', (_n, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('row 20: the 11th signer is refused with the Appendix A copy', () => {
    expect(SIGNERS_FULL_MESSAGE).toBe('An envelope can have at most 10 signers.');
  });
});

describe('email (row 22)', () => {
  const at254 = `${'a'.repeat(244)}@x.example`; // 254
  it.each([
    ['a@b.co', true],
    ['  a@b.co  ', true],
    ['a@b', false],
    ['a b@c.co', false],
    ['', false],
    ['<a@b.co>', true], // the server's pattern allows angle brackets (Appendix A)
    [at254, true],
    [`a${at254}`, false],
  ])('%j → %s', (email, ok) => {
    expect(isValidEmail(email)).toBe(ok);
  });
});

describe('access code (row 23)', () => {
  it.each([
    ['1234', '1234'],
    [' 1234 ', '1234'],
    ['123', null],
    ['x'.repeat(32), 'x'.repeat(32)],
    ['x'.repeat(33), null],
    ['ab\ncd', null],
    ['päss1', null],
    [42, null],
  ])('%j → %j', (raw, out) => {
    expect(normalizeAccessCode(raw)).toBe(out);
    if (typeof raw === 'string') expect(isValidAccessCode(raw)).toBe(out !== null);
  });
});

describe('phone E.164 {7,14} (row 24, one pattern for messaging and the profile)', () => {
  it('the pattern', () => {
    expect(E164_PATTERN.source).toBe('^\\+[1-9]\\d{7,14}$');
  });
  it.each([
    ['+14155550123', true],
    ['+12345678', true], // 8 digits
    ['+1234567', false], // 7 digits: the profile's former {1,14} accepted it
    ['+12', false],
    ['+123456789012345', true], // 15 digits
    ['+1234567890123456', false],
    ['+04155550123', false],
    ['14155550123', false],
    [null, false],
  ])('%j → %s', (v, ok) => {
    expect(isE164(v)).toBe(ok);
  });
});

describe('void, decline and delegate reasons (rows 6, 27, 28)', () => {
  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['ok', null], // mobile's minimum of 3 is dropped
    ['x'.repeat(500), null],
    ['x'.repeat(501), 'too_long'],
  ])('void %j → %j', (r, problem) => {
    expect(voidReasonProblem(r)).toBe(problem);
  });

  it.each([
    ['', false],
    ['  ', false],
    ['no', true], // mobile's minimum of 3 is dropped
  ])('decline %j → %s', (r, ok) => {
    expect(isValidDeclineReason(r)).toBe(ok);
  });

  it.each([
    [{ name: 'Ann', email: 'ann@x.co' }, true],
    [{ name: ' ', email: 'ann@x.co' }, false],
    [{ name: 'Ann', email: 'ann@x' }, false],
    [{ name: 'Ann', email: `${'a'.repeat(250)}@x.co` }, false],
    [{ name: 'Ann', email: 'ann@x.co', reason: 'x'.repeat(500) }, true],
    [{ name: 'Ann', email: 'ann@x.co', reason: 'x'.repeat(501) }, false],
    [{ name: 'x'.repeat(201), email: 'ann@x.co' }, false],
  ])('delegate %j → %s', (input, ok) => {
    expect(isValidDelegate(input)).toBe(ok);
  });
});
