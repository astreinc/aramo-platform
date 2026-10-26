import { describe, expect, it } from 'vitest';

import { ReminderLimitError } from '../lib/domain/envelope-contract-errors.js';
import { SIGN_REMINDER_LIMITS, applyReminderLimits, envelopeReminderAvailableAt, nextReminderAt, type ReminderHistoryEntry } from '../lib/reminder-limits.js';

// Aramo Sign Mobile M-A3 §7 — the reminder limit arithmetic (the enforcing read
// runs under the envelope row lock; see envelope-contracts.integration.spec.ts).

const NOW = new Date('2026-10-25T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const L = SIGN_REMINDER_LIMITS;

describe('reminder limits — 60 minutes per signer, 5 per envelope per rolling 24 hours', () => {
  it('the approved values', () => {
    expect(L).toEqual({ per_signer_cooldown_ms: 3_600_000, per_envelope_window_ms: 86_400_000, per_envelope_max: 5 });
  });

  it('a signer reminded 59 minutes ago waits; at 60 minutes they may be reminded', () => {
    const h: ReminderHistoryEntry[] = [{ occurred_at: min(59), signer_ids: ['a'] }];
    expect(nextReminderAt(h, 'a', NOW, L)).toEqual(new Date(min(59).getTime() + 3_600_000));
    expect(nextReminderAt([{ occurred_at: min(60), signer_ids: ['a'] }], 'a', NOW, L)).toBeNull();
    expect(nextReminderAt(h, 'b', NOW, L)).toBeNull();
  });

  it('a reminder recorded without signer ids counts against every signer', () => {
    expect(nextReminderAt([{ occurred_at: min(5), signer_ids: null }], 'anyone', NOW, L)).not.toBeNull();
  });

  it('the sixth reminder inside 24 hours is refused until the oldest ages out', () => {
    const five: ReminderHistoryEntry[] = [600, 500, 400, 300, 200].map((m, i) => ({ occurred_at: min(m), signer_ids: [`s${i}`] }));
    expect(envelopeReminderAvailableAt(five.slice(0, 4), NOW, L)).toBeNull();
    expect(envelopeReminderAvailableAt(five, NOW, L)).toEqual(new Date(min(600).getTime() + 86_400_000));
    // Events older than the window do not count.
    expect(envelopeReminderAvailableAt([{ occurred_at: min(24 * 60 + 1), signer_ids: ['x'] }, ...five.slice(1)], NOW, L)).toBeNull();
  });

  it('apply: the daily limit refuses the whole call; the cooldown keeps only signers out of it', () => {
    const five: ReminderHistoryEntry[] = [600, 500, 400, 300, 200].map((m) => ({ occurred_at: min(m), signer_ids: ['z'] }));
    const daily = applyReminderLimits(five, ['a'], NOW, L);
    expect(daily.refused).toBeInstanceOf(ReminderLimitError);
    expect(daily.refused?.reason).toBe('reminder_daily_limit');

    const recent: ReminderHistoryEntry[] = [{ occurred_at: min(10), signer_ids: ['a'] }];
    expect(applyReminderLimits(recent, ['a', 'b'], NOW, L)).toEqual({ allowed: ['b'] });
    const cooling = applyReminderLimits(recent, ['a'], NOW, L);
    expect(cooling.refused?.reason).toBe('reminder_cooldown');
    expect(cooling.refused?.retryAt).toEqual(new Date(min(10).getTime() + 3_600_000));
  });
});
