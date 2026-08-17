import { describe, expect, it } from 'vitest';

import { safeErrorMessage } from './errors';

// T10-B2 §2 / F-018 (S1) — the product-safe error fallback must NEVER surface a
// raw thrown-error message, even when the frontend caught it.
describe('safeErrorMessage', () => {
  it('never returns a raw Error message — returns the safe fallback', () => {
    const err = new Error('Prisma: connection to db-internal-7 failed at 10.0.0.4:5432');
    expect(safeErrorMessage(err, 'Unable to load users. Try again.')).toBe(
      'Unable to load users. Try again.',
    );
  });

  it('never returns raw text for a thrown string / unknown value', () => {
    expect(safeErrorMessage('ECONNRESET', 'Something went wrong.')).toBe(
      'Something went wrong.',
    );
    expect(safeErrorMessage({ message: 'Forbidden: missing scope compensation:view:pay' }, 'Something went wrong.')).toBe(
      'Something went wrong.',
    );
    expect(safeErrorMessage(undefined, 'Something went wrong.')).toBe('Something went wrong.');
  });

  it('does not surface an ApiError-shaped .message (internal envelope text)', () => {
    const apiish = { name: 'ApiError', status: 500, message: 'internal provider failure: stack…' };
    expect(safeErrorMessage(apiish, 'Unable to load. Try again.')).toBe(
      'Unable to load. Try again.',
    );
  });

  it('surfaces ONLY an explicit, governed userMessage opt-in', () => {
    expect(safeErrorMessage({ userMessage: 'That branch name is already in use.' }, 'fallback')).toBe(
      'That branch name is already in use.',
    );
    // A non-string userMessage is ignored (falls back).
    expect(safeErrorMessage({ userMessage: 123 }, 'fallback')).toBe('fallback');
  });
});
