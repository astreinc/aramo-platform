// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit rows 8 and 29: one refusal → copy map; the server's text is never shown.
import { ENVELOPE_CHANGED, FALLBACK_MESSAGE, NO_PERMISSION, REFUSAL_COPY, STORAGE_FULL, WORD_COPY, refusalMessage, type RefusalInput } from '../index.js';

const fmt = { time: (iso: string) => `T(${iso})`, date: (iso: string) => `D(${iso})` };

describe('refusal copy (row 29)', () => {
  it.each<[string, RefusalInput, string]>([
    ['reason wins over code', { code: 'VALIDATION_ERROR', reason: 'witness_duplicate', status: 400 }, 'A signer can have only one witness.'],
    ['reason from details', { code: 'X', details: { reason: 'inbox_item_not_found' } }, 'This item changed. Showing your latest inbox.'],
    ['code when no reason', { code: 'ENVELOPE_NOT_FOUND', status: 404 }, 'This envelope isn’t available. It may have been deleted, or you don’t have access to it.'],
    ['mobile passes the code as the reason', { code: 'ENVELOPE_PURGED', reason: 'ENVELOPE_PURGED', status: 410 }, 'This envelope’s documents were purged and can’t be downloaded.'],
    ['an unknown 403', { code: 'INSUFFICIENT_PERMISSIONS', status: 403 }, NO_PERMISSION],
    ['an unknown refusal: the fallback, never server text', { code: 'VALIDATION_ERROR', status: 400 }, FALLBACK_MESSAGE],
    ['storage (one wording)', { code: 'ESIGN_STORAGE_QUOTA_EXCEEDED', status: 409 }, STORAGE_FULL],
    ['phone verification (mobile wording)', { code: 'X', reason: 'phone_verification_required', status: 403 }, 'Verify your phone number to send.'],
    ['review pending (mobile wording)', { code: 'X', reason: 'personal_review_pending', status: 403 }, 'Sending is paused while we review your account.'],
    ['legal acceptance (mobile wording)', { code: 'X', reason: 'legal_acceptance_required', status: 403 }, 'Accept the updated terms to keep sending.'],
    ['Word too large', { code: 'VALIDATION_ERROR', reason: 'word_too_large' }, WORD_COPY.word_too_large],
    ['reports feature', { code: 'ESIGN_FEATURE_NOT_AVAILABLE', details: { feature_key: 'sign.reports' } }, 'Reports aren’t available on your Aramo Sign plan yet.'],
    ['templates not in plan', { code: 'ESIGN_FEATURE_NOT_AVAILABLE', details: { reason: 'templates_not_in_plan' } }, 'Templates aren’t included in the Free plan. They come with every paid Aramo Sign plan.'],
    ['seat limit', { code: 'ESIGN_BILLING_CONFLICT', details: { reason: 'seat_limit_reached', purchased: 3 } }, 'All 3 seats are in use. Add a seat to invite more people.'],
    ['seats below usage', { code: 'ESIGN_BILLING_CONFLICT', details: { reason: 'seats_below_usage', used: 4 } }, '4 people are using seats, so you need at least 4 seats. Remove someone’s Aramo Sign access first to go lower.'],
    ['billing conflict, no reason', { code: 'ESIGN_BILLING_CONFLICT', status: 409 }, 'Your organization can’t subscribe right now. Check Settings, or contact Aramo.'],
    ['self-sign: not bound', { code: 'ENVELOPE_ILLEGAL_TRANSITION', reason: 'not_bound_to_you' }, 'This signer isn’t assigned to you. Use the link in the signing email.'],
  ])('%s', (_n, e, copy) => {
    expect(refusalMessage(e, fmt)).toBe(copy);
  });

  it('a caller fallback replaces the default', () => {
    expect(refusalMessage({ code: 'NOPE' }, fmt, 'Couldn’t save.')).toBe('Couldn’t save.');
  });

  it('every mapped value is plain copy (no empty entries)', () => {
    for (const [k, v] of Object.entries(REFUSAL_COPY)) expect([k, v.length > 0]).toEqual([k, true]);
  });
});

describe('allowance refusals say "documents" (row 17)', () => {
  it.each<[string, RefusalInput, string]>([
    ['monthly', { code: 'ESIGN_ALLOWANCE_EXHAUSTED', details: { limit: 25, period_end: '2026-12-01' } }, 'You’ve used all 25 documents this month. Your allowance resets on D(2026-12-01).'],
    ['daily', { code: 'ESIGN_ALLOWANCE_EXHAUSTED', details: { reason: 'DAILY_LIMIT_REACHED', limit: 2, next_available_at: '2026-11-22T09:00:00Z' } }, 'You’ve sent 2 documents in the last 24 hours, the most your plan allows. You can send again at T(2026-11-22T09:00:00Z).'],
    ['monthly, nothing known', { code: 'ESIGN_ALLOWANCE_EXHAUSTED' }, 'You’ve used all your documents this month.'],
  ])('%s', (_n, e, copy) => {
    expect(refusalMessage(e, fmt)).toBe(copy);
  });
});

describe('reminder refusals (row 8, one wording)', () => {
  it.each<[string, RefusalInput, string]>([
    ['cooldown with retry_at', { code: 'ESIGN_REMINDER_NOT_ALLOWED', status: 429, reason: 'reminder_cooldown', details: { retry_at: 'R' } }, 'This signer was reminded less than an hour ago. You can send another reminder at T(R).'],
    ['daily limit, client retry time', { code: 'ESIGN_REMINDER_NOT_ALLOWED', status: 429, reason: 'reminder_daily_limit', retryAt: 'Q' }, 'This envelope has had the most reminders allowed in 24 hours. You can send another reminder at T(Q).'],
    ['cooldown, no time', { code: 'ESIGN_REMINDER_NOT_ALLOWED', status: 429, reason: 'reminder_cooldown' }, 'This signer was reminded less than an hour ago.'],
    ['stale (409, no reason)', { code: 'ESIGN_REMINDER_NOT_ALLOWED', status: 409 }, ENVELOPE_CHANGED],
    ['stale (mobile: reason = code)', { code: 'ESIGN_REMINDER_NOT_ALLOWED', reason: 'ESIGN_REMINDER_NOT_ALLOWED', status: 409 }, ENVELOPE_CHANGED],
    ['self-sign', { code: 'ESIGN_REMINDER_NOT_ALLOWED', status: 409, reason: 'self_sign_no_reminders' }, 'A document you sign yourself has no one to remind.'],
  ])('%s', (_n, e, copy) => {
    expect(refusalMessage(e, fmt)).toBe(copy);
  });
});
