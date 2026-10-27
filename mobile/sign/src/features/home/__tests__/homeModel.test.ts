// Home model (M-A4 §2): welcome name, count chips (same as Agreements filters), assigned
// tasks from `can_sign` only, 5 most recent rows, and the Personal plan banner copy.
import { countFor, mergeAgreements } from '../../inbox/agreementsModel';
import { received, sent } from '../../inbox/__tests__/fixtures';
import type { BillingAccount, InboxList } from '../../inbox/types';
import {
  assignedTasks,
  firstName,
  homeChips,
  homeModel,
  planBanner,
  recentActivity,
  welcomeText,
} from '../homeModel';

const inbox = (waiting: InboxList['waiting'], completed: InboxList['completed'] = []): InboxList =>
  ({ waiting, completed, other: [] }) as unknown as InboxList;

function account(over: {
  kind?: 'PERSONAL' | 'BUSINESS';
  source?: 'FREE' | 'SELF_SERVICE' | 'MANUAL';
  allowance?: Record<string, unknown>;
}): BillingAccount {
  return {
    tenant_kind: over.kind ?? 'PERSONAL',
    subscription: { source: over.source ?? 'FREE' },
    allowance: over.allowance ?? {},
  } as unknown as BillingAccount;
}

const FREE_ALLOWANCE = {
  limit: 5,
  used: 2,
  remaining: 3,
  period_end: '2026-11-01T12:00:00.000Z',
  daily: { window: 'DAY', limit: 2, used: 1, remaining: 1, next_available_at: null },
};

describe('welcome', () => {
  it('uses the first word of the server display name', () => {
    expect(firstName('Priya Raman')).toBe('Priya');
    expect(firstName('  Ana  ')).toBe('Ana');
    expect(welcomeText('Priya Raman')).toBe('Welcome, Priya');
  });
  it('never guesses a name', () => {
    expect(firstName(null)).toBeNull();
    expect(firstName('   ')).toBeNull();
    expect(welcomeText(undefined)).toBe('Welcome');
  });
});

describe('count chips', () => {
  it('match the Agreements waiting / drafts filters', () => {
    const rows = mergeAgreements(
      [sent('IN_PROGRESS'), sent('SENT'), sent('DRAFT'), sent('COMPLETED')],
      inbox([received({ can_sign: true }), received({ can_sign: false, my_status: 'SIGNED' })]),
      [
        {
          localId: 'local-draft-1',
          envelopeId: null,
          baseRevision: null,
          step: 'documents',
          updatedAt: '2026-10-05T00:00:00.000Z',
          payload: {},
        },
      ],
    );
    const chips = homeChips(rows);
    expect(chips.map((c) => [c.filter, c.label])).toEqual([
      ['waiting', 'Waiting for others'],
      ['drafts', 'Drafts'],
    ]);
    expect(chips[0]?.count).toBe(countFor(rows, 'waiting'));
    expect(chips[0]?.count).toBe(3);
    expect(chips[1]?.count).toBe(countFor(rows, 'drafts'));
    expect(chips[1]?.count).toBe(2);
  });
});

describe('assigned tasks', () => {
  it('come only from inbox items the server says can be signed', () => {
    const a = received({ subject: 'NDA', can_sign: true, sent_at: '2026-10-20T10:00:00.000Z' });
    const b = received({ subject: 'Signed already', can_sign: false, my_status: 'SIGNED' });
    const rows = mergeAgreements([sent('IN_PROGRESS', { subject: 'Mine' })], inbox([a, b]));
    const tasks = assignedTasks(rows, Date.parse('2026-10-20T13:00:00.000Z'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      inboxItemId: a.id,
      subject: 'NDA',
      subtitle: 'From Northwind Staffing · 3h',
    });
  });

  it('never derive a task from a sent envelope addressed to the user (no email match)', () => {
    const mine = sent('IN_PROGRESS', {
      recipients: [{ id: 'r1', name: 'Me', email: 'me@example.com', status: 'PENDING' }],
    } as never);
    expect(assignedTasks(mergeAgreements([mine], inbox([])))).toEqual([]);
  });

  it('falls back to "Received" when the sender organization is unknown', () => {
    const rows = mergeAgreements([], inbox([received({ from: null, sent_at: null })]));
    expect(assignedTasks(rows)[0]?.subtitle).toBe('Received');
  });
});

describe('recent activity', () => {
  it('keeps the 5 most recent rows, newest first', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      sent('IN_PROGRESS', {
        subject: `S${i}`,
        last_activity_at: `2026-10-1${i}T10:00:00.000Z`,
      }),
    );
    const out = recentActivity(mergeAgreements(items, null));
    expect(out.map((r) => r.subject)).toEqual(['S6', 'S5', 'S4', 'S3', 'S2']);
  });
});

describe('plan banner', () => {
  it('is null for Business tenants and uncounted Personal accounts', () => {
    expect(planBanner(account({ kind: 'BUSINESS', allowance: FREE_ALLOWANCE }))).toBeNull();
    expect(planBanner(account({ allowance: { unlimited: true } }))).toBeNull();
    expect(planBanner(account({ allowance: { subscribed: false } }))).toBeNull();
    expect(planBanner(null)).toBeNull();
  });

  it('uses the prototype copy on the Free plan, with the server values', () => {
    expect(planBanner(account({ allowance: FREE_ALLOWANCE }))).toEqual({
      tone: 'plan',
      title: '3 of 5 free sends left this month',
      body: 'Up to 2 a day. Signing is always free.',
    });
  });

  it('omits the day sentence when the server reports no day window', () => {
    const { daily: _d, ...monthOnly } = FREE_ALLOWANCE;
    expect(planBanner(account({ allowance: monthOnly }))?.body).toBe('Signing is always free.');
  });

  it('falls back to the allowance chip copy when not on the Free plan', () => {
    expect(planBanner(account({ source: 'SELF_SERVICE', allowance: FREE_ALLOWANCE }))).toEqual({
      tone: 'plan',
      title: '3 of 5 left this month · 1 of 2 left today',
      body: null,
    });
  });

  it('shows the existing daily limit copy with the exact time, never "tomorrow"', () => {
    const b = planBanner(
      account({
        allowance: {
          ...FREE_ALLOWANCE,
          daily: {
            ...FREE_ALLOWANCE.daily,
            used: 2,
            remaining: 0,
            next_available_at: '2026-10-28T15:05:00.000Z',
          },
        },
      }),
    );
    expect(b?.tone).toBe('limit');
    expect(b?.title).toBe('Daily limit reached');
    expect(b?.body).toMatch(/You can send again at Oct 28, 2026, /);
    expect(JSON.stringify(b)).not.toMatch(/tomorrow/i);
  });

  it('shows the monthly limit first', () => {
    const b = planBanner(account({ allowance: { ...FREE_ALLOWANCE, used: 5, remaining: 0 } }));
    expect(b).toEqual({
      tone: 'limit',
      title: 'Monthly limit reached',
      body: 'You’ve used all 5 documents this month. Your allowance resets on Nov 1, 2026.',
    });
  });
});

describe('homeModel', () => {
  it('assembles the whole Home', () => {
    const rows = mergeAgreements([sent('DRAFT')], inbox([received({ can_sign: true })]));
    const m = homeModel({ rows, displayName: 'Priya Raman', billing: null });
    expect(m.welcome).toBe('Welcome, Priya');
    expect(m.tasksHeading).toBe('Assigned tasks (1)');
    expect(m.activity).toHaveLength(2);
    expect(m.banner).toBeNull();
  });
});
