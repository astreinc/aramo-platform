// SIGN-FREE-PARITY-1 S4 (FP-R5) — the automatic reminder cadence and copy (vitest and mobile Jest).
import {
  AUTO_REMINDER_CADENCE,
  AUTO_REMINDER_COPY,
  AUTO_REMINDER_DAY_MS,
  autoReminderAfterSent,
  autoReminderDueAt,
  autoReminderOnEnable,
  autoReminderStatusLine,
  canSetAutoReminders,
} from '../index.js';

const SENT = Date.parse('2026-11-27T10:00:00.000Z');
const day = (n: number): number => n * AUTO_REMINDER_DAY_MS;

describe('automatic reminder cadence', () => {
  it('is 2 days, then every 3 days, at most 5', () => {
    expect(AUTO_REMINDER_CADENCE).toEqual({ first_after_days: 2, every_days: 3, max_count: 5 });
  });

  it('the first is due 2 days after sending, each next one 3 days later', () => {
    expect(autoReminderDueAt(SENT, 0)?.getTime()).toBe(SENT + day(2));
    expect(autoReminderDueAt(SENT, 1)?.getTime()).toBe(SENT + day(5));
    expect(autoReminderDueAt(new Date(SENT), 4)?.getTime()).toBe(SENT + day(14));
    expect(autoReminderDueAt(new Date(SENT).toISOString(), 2)?.getTime()).toBe(SENT + day(8));
  });

  it('none is due once 5 were sent', () => {
    expect(autoReminderDueAt(SENT, 5)).toBeNull();
    expect(autoReminderDueAt(SENT, 6)).toBeNull();
  });

  it('after one went out the next is 3 days later, none after the fifth', () => {
    const now = SENT + day(2) + 60_000;
    expect(autoReminderAfterSent(now, 1)?.getTime()).toBe(now + day(3));
    expect(autoReminderAfterSent(now, 4)?.getTime()).toBe(now + day(3));
    expect(autoReminderAfterSent(now, 5)).toBeNull();
  });

  it('turned back on: the plain cadence time, or now when it has passed', () => {
    expect(autoReminderOnEnable(SENT, 0, SENT + day(1))?.getTime()).toBe(SENT + day(2));
    expect(autoReminderOnEnable(SENT, 0, SENT + day(9))?.getTime()).toBe(SENT + day(9));
    expect(autoReminderOnEnable(SENT, 5, SENT + day(1))).toBeNull();
  });
});

describe('canSetAutoReminders', () => {
  it('draft and open envelopes, never a closed or self-signed one', () => {
    expect(canSetAutoReminders({ status: 'DRAFT' })).toBe(true);
    expect(canSetAutoReminders({ status: 'SENT', mode: 'standard' })).toBe(true);
    expect(canSetAutoReminders({ status: 'IN_PROGRESS' })).toBe(true);
    for (const status of ['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']) expect(canSetAutoReminders({ status })).toBe(false);
    expect(canSetAutoReminders({ status: 'SENT', mode: 'self' })).toBe(false);
    expect(canSetAutoReminders({ status: 'DRAFT', envelope_mode: 'SELF' })).toBe(false);
  });
});

describe('autoReminderStatusLine', () => {
  const fmt = (iso: string): string => iso.slice(0, 10);
  it('off, on with the next date, all sent, or plain on', () => {
    expect(autoReminderStatusLine({ enabled: false, sent_count: 0, max_count: 5, next_at: null }, fmt)).toBe(AUTO_REMINDER_COPY.off);
    expect(autoReminderStatusLine({ enabled: true, sent_count: 1, max_count: 5, next_at: '2026-12-02T10:00:00.000Z' }, fmt)).toBe(
      'Automatic reminders are on. Next one: 2026-12-02.',
    );
    expect(autoReminderStatusLine({ enabled: true, sent_count: 5, max_count: 5, next_at: null }, fmt)).toBe(AUTO_REMINDER_COPY.all_sent);
    expect(autoReminderStatusLine({ enabled: true, sent_count: 0, max_count: 5, next_at: null }, fmt)).toBe(AUTO_REMINDER_COPY.on);
    expect(autoReminderStatusLine(undefined, fmt)).toBeNull();
  });

  it('the help line states the cadence', () => {
    expect(AUTO_REMINDER_COPY.help).toBe('Remind signers 2 days after sending, then every 3 days (up to 5).');
  });
});
