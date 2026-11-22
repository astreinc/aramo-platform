// Client Rule Consolidation C2-5 — runs under vitest and mobile Jest (globals only).
// Audit row 1: the terminal / open envelope status sets (ES-1).
import { ENVELOPE_TRANSITIONS, SIGNABLE_ENVELOPE_STATUSES, TERMINAL_ENVELOPE_STATUSES, isTerminalEnvelopeStatus, predecessorsOf } from '../index.js';

describe('envelope status sets', () => {
  it.each([
    ['DRAFT', false],
    ['SENT', false],
    ['IN_PROGRESS', false],
    ['COMPLETED', true],
    ['DECLINED', true],
    ['VOIDED', true],
    ['EXPIRED', true],
    ['UNKNOWN', false],
  ])('isTerminalEnvelopeStatus(%s) = %s', (status, expected) => {
    expect(isTerminalEnvelopeStatus(status)).toBe(expected);
  });

  it('a terminal status has no outgoing transition; every other one has', () => {
    for (const [from, next] of Object.entries(ENVELOPE_TRANSITIONS)) {
      expect(next.length === 0).toBe(TERMINAL_ENVELOPE_STATUSES.includes(from));
    }
  });

  it('the signable statuses are SENT and IN_PROGRESS', () => {
    expect([...SIGNABLE_ENVELOPE_STATUSES]).toEqual(['SENT', 'IN_PROGRESS']);
  });

  it.each([
    ['SENT', ['DRAFT']],
    ['IN_PROGRESS', ['SENT']],
    ['COMPLETED', ['IN_PROGRESS']],
    ['VOIDED', ['DRAFT', 'SENT', 'IN_PROGRESS']],
    ['EXPIRED', ['SENT', 'IN_PROGRESS']],
    ['DRAFT', []],
  ])('predecessorsOf(%s)', (to, expected) => {
    expect(predecessorsOf(to)).toEqual(expected);
  });
});
