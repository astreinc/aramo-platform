// Agreements filter merge (handoff §4.2; directive §7 C-12).
import type { LocalDraft } from '../../../state/draftStore';
import {
  asListFilter,
  asListRange,
  countFor,
  DEFAULT_RANGE,
  FILTER_LABEL,
  FILTERS,
  filterAgreements,
  inRange,
  listHeading,
  statusIcon,
  type ListRange,
  mergeAgreements,
  needsSignatureSummary,
  pillFor,
  relativeTime,
  secondaryLine,
} from '../agreementsModel';
import { allowanceChipText, allowanceModel, limitBanner } from '../allowance';
import { ENVELOPE_STATUSES, type BillingAccount, type InboxList } from '../types';
import { received, sent } from './fixtures';

const inbox = (over: Partial<InboxList> = {}): InboxList => ({
  waiting: [],
  completed: [],
  other: [],
  ...over,
});

describe('mergeAgreements + filters', () => {
  const allSent = ENVELOPE_STATUSES.map((s) => sent(s));
  const needs = received({ subject: 'Needs me', can_sign: true });
  const signedWaiting = received({
    subject: 'I signed, others pending',
    can_sign: false,
    my_status: 'SIGNED',
  });
  const recvDone = received({
    subject: 'Received done',
    envelope_status: 'COMPLETED',
    can_sign: false,
    can_download: true,
    my_status: 'SIGNED',
  });
  const recvVoided = received({
    subject: 'Received voided',
    envelope_status: 'VOIDED',
    can_sign: false,
  });
  const rows = mergeAgreements(
    allSent,
    inbox({ waiting: [needs], completed: [recvDone], other: [signedWaiting, recvVoided] }),
  );

  it('renders all 7 statuses (SENT included) across the four filters', () => {
    const covered = new Set<string>();
    for (const f of ['needs_me', 'waiting', 'drafts', 'done'] as const)
      for (const r of filterAgreements(rows, f)) covered.add(r.status);
    for (const s of ENVELOPE_STATUSES) expect(covered.has(s)).toBe(true);
  });

  it('Needs me = received items the server says can be signed now', () => {
    const r = filterAgreements(rows, 'needs_me');
    expect(r.map((x) => x.subject)).toEqual(['Needs me']);
    expect(pillFor(r[0]!)).toBe('NEEDS_ME');
    expect(countFor(rows, 'needs_me')).toBe(1);
  });

  it('Waiting = other open envelopes: sent SENT / IN_PROGRESS and received ones I finished', () => {
    const r = filterAgreements(rows, 'waiting');
    expect(r.map((x) => x.status).sort()).toEqual(['IN_PROGRESS', 'IN_PROGRESS', 'SENT']);
    expect(r.some((x) => x.subject === 'I signed, others pending')).toBe(true);
    expect(r.some((x) => x.subject === 'Needs me')).toBe(false);
  });

  it('Drafts = DRAFT envelopes plus local drafts not yet on the server', () => {
    const local: LocalDraft[] = [
      {
        localId: 'l1',
        envelopeId: null,
        baseRevision: null,
        step: 'documents',
        updatedAt: '2026-10-09T00:00:00.000Z',
        payload: { subject: 'On this phone' },
      },
      {
        localId: 'l2',
        envelopeId: allSent[0]!.id,
        baseRevision: 1,
        step: 'review',
        updatedAt: '2026-10-09T00:00:00.000Z',
        payload: {},
      },
    ];
    const r = filterAgreements(mergeAgreements(allSent, null, local), 'drafts');
    expect(r.map((x) => x.subject)).toEqual(['On this phone', 'Sent DRAFT']);
    expect(secondaryLine(r[0]!)).toContain('not sent');
  });

  it('Done = COMPLETED · DECLINED · VOIDED · EXPIRED, sent and received', () => {
    const r = filterAgreements(rows, 'done');
    expect(new Set(r.map((x) => x.status))).toEqual(
      new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']),
    );
    expect(r.some((x) => x.kind === 'received')).toBe(true);
  });

  it('search matches the subject only, case-insensitively', () => {
    expect(filterAgreements(rows, 'done', 'received DONE').map((x) => x.subject)).toEqual([
      'Received done',
    ]);
    expect(filterAgreements(rows, 'done', 'alex')).toEqual([]);
  });

  it('sorts by latest activity, newest first', () => {
    const a = sent('IN_PROGRESS', { subject: 'old', last_activity_at: '2026-10-01T00:00:00.000Z' });
    const b = sent('IN_PROGRESS', { subject: 'new', last_activity_at: '2026-10-05T00:00:00.000Z' });
    expect(mergeAgreements([a, b], null).map((x) => x.subject)).toEqual(['new', 'old']);
  });

  it('sent status lines follow handoff §2A / M-A4 §3.4', () => {
    const line = (e: ReturnType<typeof sent>) => secondaryLine(mergeAgreements([e], null)[0]!);
    expect(line(sent('IN_PROGRESS'))).toBe('Waiting for others · 1 of 2 signed');
    expect(line(sent('SENT'))).toBe('Waiting for others · 1 of 2 signed');
    expect(line(sent('DRAFT'))).toBe('Draft · not sent');
    expect(line(sent('VOIDED'))).toBe('Voided');
    expect(line(sent('EXPIRED'))).toBe('Expired');
    // Multi-signer: the list has no per-signer signed_at, so no "last signer" (Gap).
    expect(line(sent('COMPLETED'))).toBe('Completed');
    expect(
      line(
        sent('COMPLETED', {
          recipients: [
            { id: 'x', name: 'Jo Doe', email: 'j@x', status: 'SIGNED', recipient_kind: 'SIGNER' },
          ],
        }),
      ),
    ).toBe('Completed by Jo Doe');
    expect(
      line(
        sent('DECLINED', {
          recipients: [
            { id: 'x', name: 'Jo Doe', email: 'j@x', status: 'DECLINED', recipient_kind: 'SIGNER' },
          ],
        }),
      ),
    ).toBe('Declined by Jo Doe');
    expect(line(sent('DECLINED'))).toBe('Declined by a signer');
  });

  it('copy recipients are never counted or named as signers (M-A5)', () => {
    const line = (e: ReturnType<typeof sent>) => secondaryLine(mergeAgreements([e], null)[0]!);
    const cc = {
      id: 'c',
      name: 'Procurement',
      email: 'p@x',
      status: 'PENDING' as const,
      recipient_kind: 'RECEIVES_COPY' as const,
    };
    const signer = {
      id: 's',
      name: 'Jo Doe',
      email: 'j@x',
      status: 'SIGNED' as const,
      recipient_kind: 'SIGNER' as const,
    };
    expect(line(sent('COMPLETED', { recipients: [signer, cc] }))).toBe('Completed by Jo Doe');
    expect(line(sent('IN_PROGRESS', { recipients: [{ ...signer, status: 'PENDING' }, cc] }))).toBe(
      'Waiting for others · 0 of 1 signed',
    );
  });

  it('received status lines never name or count other recipients (A8/A9, C-6)', () => {
    const line = (i: ReturnType<typeof received>) =>
      secondaryLine(mergeAgreements([], inbox({ other: [i] }))[0]!);
    expect(line(needs)).toBe('Needs your signature · from Northwind Staffing');
    expect(line(received({ can_sign: true, from: null }))).toBe('Needs your signature');
    expect(line(signedWaiting)).toBe('You signed · waiting for others');
    expect(line(recvDone)).toBe('Completed');
    expect(line(recvVoided)).toBe('Voided');
    expect(
      line(received({ envelope_status: 'DECLINED', my_status: 'DECLINED', can_sign: false })),
    ).toBe('You declined');
    expect(
      line(received({ envelope_status: 'DECLINED', my_status: 'SIGNED', can_sign: false })),
    ).toBe('Declined');
    expect(line(received({ envelope_status: 'EXPIRED', can_sign: false }))).toBe('Expired');
    for (const s of ENVELOPE_STATUSES) {
      for (const my of ['PENDING', 'VIEWED', 'SIGNED', 'DECLINED'] as const) {
        const l = line(received({ envelope_status: s, my_status: my, can_sign: false }));
        expect(l).not.toMatch(/\d+ of \d+|by /);
      }
    }
  });

  it('status icons by state', () => {
    const icon = (e: ReturnType<typeof sent>) => statusIcon(mergeAgreements([e], null)[0]!);
    expect(statusIcon(mergeAgreements([], inbox({ waiting: [needs] }))[0]!)).toBe('needs');
    expect(icon(sent('SENT'))).toBe('waiting');
    expect(icon(sent('IN_PROGRESS'))).toBe('waiting');
    expect(icon(sent('DRAFT'))).toBe('draft');
    expect(icon(sent('COMPLETED'))).toBe('completed');
    expect(icon(sent('DECLINED'))).toBe('stopped');
    expect(icon(sent('VOIDED'))).toBe('stopped');
    expect(icon(sent('EXPIRED'))).toBe('expired');
  });

  it('All = every row; Completed (done) covers the 4 end states of the 7', () => {
    expect(filterAgreements(rows, 'all')).toHaveLength(rows.length);
    expect(FILTERS).toEqual(['all', 'needs_me', 'waiting', 'drafts', 'done']);
    expect(FILTER_LABEL.done).toBe('Completed');
    expect(FILTER_LABEL.waiting).toBe('Waiting for others');
  });

  it('last-activity range filters on the device by activityAt', () => {
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const when = (iso: string) => ({ last_activity_at: iso, sent_at: iso, created_at: iso });
    const list = mergeAgreements(
      [
        sent('IN_PROGRESS', { subject: 'd10', ...when(at(10)) }),
        sent('IN_PROGRESS', { subject: 'd100', ...when(at(100)) }),
        sent('IN_PROGRESS', { subject: 'd300', ...when(at(300)) }),
        sent('IN_PROGRESS', { subject: 'd500', ...when(at(500)) }),
      ],
      null,
    );
    const subj = (r: ListRange) => filterAgreements(list, 'all', '', r, now).map((x) => x.subject);
    expect(subj('30d')).toEqual(['d10']);
    expect(subj('6m')).toEqual(['d10', 'd100']);
    expect(subj('12m')).toEqual(['d10', 'd100', 'd300']);
    expect(subj('all')).toEqual(['d10', 'd100', 'd300', 'd500']);
    expect(inRange(list[0]!, '30d', now)).toBe(true);
    // default range keeps the old call shape unfiltered by time
    expect(filterAgreements(list, 'all')).toHaveLength(4);
    expect(DEFAULT_RANGE).toBe('6m');
  });

  it('header line "{filter} · {range}" and route value mapping', () => {
    expect(listHeading('all', '6m')).toBe('All agreements · Last 6 months');
    expect(listHeading('done', 'all')).toBe('Completed · All time');
    expect(listHeading('waiting', '30d')).toBe('Waiting for others · Last 30 days');
    expect(asListFilter('drafts')).toBe('drafts');
    expect(asListFilter('all')).toBe('all');
    expect(asListFilter('bogus')).toBeUndefined();
    expect(asListFilter(undefined)).toBeUndefined();
    expect(asListRange('12m')).toBe('12m');
    expect(asListRange(30)).toBeUndefined();
  });

  it('the needs-signature card summarizes received items needing me', () => {
    const s = needsSignatureSummary(rows);
    expect(s.count).toBe(1);
    expect(s.newest?.subject).toBe('Needs me');
  });

  it('relative times: now / 5m / 3h / 2d / Oct 12', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    expect(relativeTime('2026-10-20T11:59:30.000Z', now)).toBe('now');
    expect(relativeTime('2026-10-20T11:55:00.000Z', now)).toBe('5m');
    expect(relativeTime('2026-10-20T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-10-18T12:00:00.000Z', now)).toBe('2d');
    expect(relativeTime('2026-10-12T12:00:00.000Z', now)).toMatch(/^Oct 1[12]$/);
  });
});

describe('Personal allowance (C-3, C-4)', () => {
  const acct = (allowance: Record<string, unknown>, kind: 'PERSONAL' | 'BUSINESS' = 'PERSONAL') =>
    ({
      tenant_kind: kind,
      allowance,
      subscription: null,
      storage: null,
      billing_available: false,
      self_service_eligible: false,
      can_manage_billing: false,
    }) as unknown as BillingAccount;

  it('chip shows month and day remaining; Business shows nothing', () => {
    const m = allowanceModel(
      acct({
        limit: 5,
        used: 3,
        remaining: 2,
        period_end: '2026-11-01T00:00:00.000Z',
        daily: { window: 'DAY', limit: 2, used: 1, remaining: 1, next_available_at: null },
      }),
    );
    expect(allowanceChipText(m!)).toBe('2 of 5 left this month · 1 of 2 left today');
    expect(m!.dot).toBe('ok');
    expect(allowanceModel(acct({ limit: 5, used: 0 }, 'BUSINESS'))).toBeNull();
  });

  it('daily cap shows the EXACT next send time, never "tomorrow"', () => {
    const m = allowanceModel(
      acct({
        limit: 5,
        used: 2,
        remaining: 3,
        daily: {
          window: 'DAY',
          limit: 2,
          used: 2,
          remaining: 0,
          next_available_at: '2026-10-21T15:05:00.000Z',
        },
      }),
    );
    const b = limitBanner(m)!;
    expect(b.kind).toBe('daily');
    expect(b.body).toContain('You can send again at Oct 21, 2026');
    expect(b.body.toLowerCase()).not.toContain('tomorrow');
    expect(m!.dot).toBe('day_reached');
  });

  it('monthly cap shows the reset date', () => {
    const b = limitBanner(
      allowanceModel(
        acct({ limit: 5, used: 5, remaining: 0, period_end: '2026-11-01T12:00:00.000Z' }),
      ),
    )!;
    expect(b.kind).toBe('monthly');
    expect(b.body).toBe(
      'You’ve used all 5 documents this month. Your allowance resets on Nov 1, 2026.',
    );
  });
});
