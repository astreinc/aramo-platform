import { describe, expect, it } from 'vitest';

import {
  agingDaysInTimeZone,
  classifyDueUrgency,
  comparePriorityItems,
  dueBadgeLabel,
  isoDateInTimeZone,
} from './my-desk.derivation.js';
import type { DeskPriorityItemView, DeskUrgency } from './dto/my-desk.view.js';

// The app timezone the derivation is proven against. EDT is UTC-4 in September,
// so instants near midnight UTC fall on the PRIOR civil day locally — the exact
// trap directive §38 forbids (comparing UTC strings to local dates).
const TZ = 'America/New_York';

// 2026-09-29 12:00 EDT (a mid-day "now" on Tue Sep 29).
const NOW = Date.parse('2026-09-29T16:00:00Z');

describe('classifyDueUrgency (app-timezone day boundary, §38)', () => {
  it('a due instant on a prior civil day is overdue', () => {
    // 2026-09-29T02:00Z = 2026-09-28 22:00 EDT → civil Sep 28 < Sep 29.
    expect(classifyDueUrgency(Date.parse('2026-09-29T02:00:00Z'), NOW, TZ)).toBe(
      'overdue',
    );
  });

  it('a due instant on the same civil day is today', () => {
    // 2026-09-29T23:00Z = 2026-09-29 19:00 EDT → civil Sep 29 === today.
    expect(classifyDueUrgency(Date.parse('2026-09-29T23:00:00Z'), NOW, TZ)).toBe(
      'today',
    );
  });

  it('a due instant that is "tomorrow" in UTC but still today locally is today', () => {
    // 2026-09-30T03:00Z = 2026-09-29 23:00 EDT → civil Sep 29 === today.
    expect(classifyDueUrgency(Date.parse('2026-09-30T03:00:00Z'), NOW, TZ)).toBe(
      'today',
    );
  });

  it('a due instant on a later civil day is upcoming', () => {
    expect(classifyDueUrgency(Date.parse('2026-10-01T12:00:00Z'), NOW, TZ)).toBe(
      'upcoming',
    );
  });

  it('a null due is upcoming (never overdue)', () => {
    expect(classifyDueUrgency(null, NOW, TZ)).toBe('upcoming');
  });
});

describe('agingDaysInTimeZone', () => {
  it('a same civil-day submittal is 0 days', () => {
    expect(agingDaysInTimeZone(Date.parse('2026-09-29T13:00:00Z'), NOW, TZ)).toBe(
      0,
    );
  });

  it('counts whole civil days across a month boundary (Sep 21 → Sep 29 = 8)', () => {
    expect(agingDaysInTimeZone(Date.parse('2026-09-21T15:00:00Z'), NOW, TZ)).toBe(
      8,
    );
  });

  it('never returns negative for a future instant', () => {
    expect(agingDaysInTimeZone(Date.parse('2026-10-05T12:00:00Z'), NOW, TZ)).toBe(
      0,
    );
  });
});

describe('dueBadgeLabel (prototype parity)', () => {
  it('renders "Nd overdue" for a past civil day', () => {
    expect(dueBadgeLabel(Date.parse('2026-09-27T15:00:00Z'), NOW, TZ)).toBe(
      '2d overdue',
    );
  });
  it('renders "Today" for the same civil day', () => {
    expect(dueBadgeLabel(Date.parse('2026-09-29T20:00:00Z'), NOW, TZ)).toBe(
      'Today',
    );
  });
  it('renders "Tomorrow" for the next civil day', () => {
    expect(dueBadgeLabel(Date.parse('2026-09-30T14:00:00Z'), NOW, TZ)).toBe(
      'Tomorrow',
    );
  });
  it('renders a short month/day for a further civil day', () => {
    expect(dueBadgeLabel(Date.parse('2026-10-01T14:00:00Z'), NOW, TZ)).toBe(
      'Oct 1',
    );
  });
});

describe('isoDateInTimeZone', () => {
  it('formats the app-timezone civil date as YYYY-MM-DD', () => {
    expect(isoDateInTimeZone(NOW, TZ)).toBe('2026-09-29');
    // An instant that is Sep 30 in UTC but Sep 29 locally.
    expect(isoDateInTimeZone(Date.parse('2026-09-30T02:00:00Z'), TZ)).toBe(
      '2026-09-29',
    );
  });
});

describe('comparePriorityItems (deterministic explainable order, §13)', () => {
  const item = (
    id: string,
    urgency: DeskUrgency,
    due_at: string | null,
    kind: DeskPriorityItemView['kind'] = 'task',
  ): DeskPriorityItemView => ({
    id,
    kind,
    talent_id: null,
    talent_name: null,
    requisition_id: null,
    requisition_label: null,
    label: id,
    reason: '',
    due_at,
    urgency,
    primary_action: null,
  });

  it('orders overdue before today before upcoming', () => {
    const sorted = [
      item('c', 'upcoming', '2026-10-02T12:00:00Z'),
      item('a', 'overdue', '2026-09-27T12:00:00Z'),
      item('b', 'today', '2026-09-29T12:00:00Z'),
    ]
      .slice()
      .sort(comparePriorityItems)
      .map((i) => i.id);
    expect(sorted).toEqual(['a', 'b', 'c']);
  });

  it('within a section, earliest due first then null due last then id tie-break', () => {
    const sorted = [
      item('z', 'today', null),
      item('m', 'today', '2026-09-29T18:00:00Z'),
      item('a', 'today', '2026-09-29T09:00:00Z'),
      item('y', 'today', null),
    ]
      .slice()
      .sort(comparePriorityItems)
      .map((i) => i.id);
    expect(sorted).toEqual(['a', 'm', 'y', 'z']);
  });

  it('within a section, kind precedence (submittal>rtr>engagement>follow_up>task) outranks due time', () => {
    // A due task would sort before a null-due item on due alone; kind precedence
    // must place the derived actionable work first regardless.
    const sorted = [
      item('t', 'today', '2026-09-29T08:00:00Z', 'task'),
      item('v', 'today', null, 'engagement'),
      item('s', 'today', null, 'submittal'),
      item('f', 'today', '2026-09-29T07:00:00Z', 'follow_up'),
      item('r', 'today', null, 'rtr'),
    ]
      .slice()
      .sort(comparePriorityItems)
      .map((i) => i.id);
    expect(sorted).toEqual(['s', 'r', 'v', 'f', 't']);
  });
});
