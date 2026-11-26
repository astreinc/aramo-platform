// UAT SND-14 (field-test batch 1 §4 SND-1, SND-4) — runs under vitest and mobile Jest.
// can_remind stays true during the cooldown; reminder_available_at says when it ends.
import { nextReminderAt, remindableNow, reminderLimitMessage, type ReminderRow } from '../index.js';

const NOW = Date.parse('2026-11-19T14:40:00.000Z');
type Row = ReminderRow & { readonly id: string };

describe('remindableNow', () => {
  it('a signer the server may remind, with no cooldown, can be reminded now', () => {
    expect(remindableNow<Row>([{ id: 'a', can_remind: true, reminder_available_at: null }], NOW).map((r) => r.id)).toEqual(['a']);
  });

  it('can_remind true with a future reminder_available_at is cooling down: not now', () => {
    expect(remindableNow<Row>([{ id: 'a', can_remind: true, reminder_available_at: '2026-11-19T15:40:00.000Z' }], NOW)).toEqual([]);
  });

  it('the cooldown ends at reminder_available_at (inclusive)', () => {
    const at = '2026-11-19T15:40:00.000Z';
    const row: Row = { id: 'a', can_remind: true, reminder_available_at: at };
    expect(remindableNow([row], Date.parse(at) - 1)).toEqual([]);
    expect(remindableNow([row], Date.parse(at))).toEqual([row]);
    expect(remindableNow([row], Date.parse(at) + 60_000)).toEqual([row]);
  });

  it('a signer the server never reminds is never remindable, whatever the time', () => {
    expect(remindableNow<Row>([{ id: 'a', can_remind: false, reminder_available_at: null }], NOW)).toEqual([]);
    expect(remindableNow<Row>([{ id: 'b', can_remind: false, reminder_available_at: '2026-11-19T14:00:00.000Z' }], NOW)).toEqual([]);
    expect(remindableNow<Row>([{ id: 'c' }], NOW)).toEqual([]);
  });

  it('keeps the remindable signers of a mixed envelope, in order', () => {
    const rows: Row[] = [
      { id: 'a', can_remind: true, reminder_available_at: null },
      { id: 'b', can_remind: true, reminder_available_at: '2026-11-19T15:30:00.000Z' },
      { id: 'c', can_remind: false, reminder_available_at: null },
      { id: 'd', can_remind: true, reminder_available_at: '2026-11-19T14:00:00.000Z' },
    ];
    expect(remindableNow(rows, NOW).map((r) => r.id)).toEqual(['a', 'd']);
  });

  it('an absent reminder_available_at (older server) reads as no cooldown', () => {
    expect(remindableNow<Row>([{ id: 'a', can_remind: true }], NOW).map((r) => r.id)).toEqual(['a']);
  });
});

describe('nextReminderAt', () => {
  it('the earliest reminder_available_at among the can_remind signers', () => {
    expect(
      nextReminderAt([
        { can_remind: true, reminder_available_at: '2026-11-19T15:30:00.000Z' },
        { can_remind: true, reminder_available_at: '2026-11-19T15:10:00.000Z' },
        { can_remind: false, reminder_available_at: '2026-11-19T15:00:00.000Z' },
      ]),
    ).toBe('2026-11-19T15:10:00.000Z');
  });

  it('null when no can_remind signer waits', () => {
    expect(nextReminderAt([{ can_remind: true, reminder_available_at: null }])).toBeNull();
    expect(nextReminderAt([{ can_remind: false, reminder_available_at: '2026-11-19T15:00:00.000Z' }])).toBeNull();
    expect(nextReminderAt([{ can_remind: true }])).toBeNull();
    expect(nextReminderAt([])).toBeNull();
  });

  it('pairs with remindableNow: nobody now, so the page says when (the refusal copy names the same time)', () => {
    const rows: ReminderRow[] = [{ can_remind: true, reminder_available_at: '2026-11-19T15:40:00.000Z' }];
    expect(remindableNow(rows, NOW)).toEqual([]);
    expect(nextReminderAt(rows)).toBe('2026-11-19T15:40:00.000Z');
    expect(reminderLimitMessage('reminder_cooldown', '3:40 PM')).toBe(
      'This signer was reminded less than an hour ago. You can send another reminder at 3:40 PM.',
    );
  });
});
