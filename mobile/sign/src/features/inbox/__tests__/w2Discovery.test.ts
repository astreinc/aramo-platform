// W2 Inbox Discovery (LOCKED Gate-5 plan A3.2, A3.4, A3.5; A5 matrix rows 1-9) at the
// app: discovered items render like bound ones, "upcoming" never reaches Needs me, a
// sender row waiting only for the user reads "Waiting for you" and signs with the server's
// my_inbox_item_id, R-8 from the server's i_am_sender, binding-only actions hidden for
// discovered items, and the 404 inbox_item_not_found reload.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { refusalMessage } from '../../../api/refusalMessages';
import { recordingFetch } from '../../../testing/fakes';
import { assignedTasks, homeChips } from '../../home/homeModel';
import {
  countFor,
  EMPTY_STATE,
  FILTER_LABEL,
  filterAgreements,
  mergeAgreements,
  inboxItemToSign,
  pillFor,
  secondaryLine,
  statusIcon,
  type AgreementRow,
} from '../agreementsModel';
import {
  hasBindingActions,
  INBOX_ITEM_NOT_FOUND,
  isInboxItemGone,
  startInboxSigning,
} from '../inboxSigning';
import { swipeActionsFor, type SwipeContext } from '../rowActionRules';
import type { InboxItem, InboxList, SenderContext } from '../types';
import { BASE, CTX_OWNER, received, sent, workspaceWith } from './fixtures';

const HANDLE = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8w';
const SENT_AT = '2026-11-03T10:00:00.000Z';
const ITEM_CHANGED = 'This item changed. Showing your latest inbox.';

const inbox = (over: Partial<InboxList> = {}): InboxList => ({
  waiting: [],
  completed: [],
  other: [],
  ...over,
});
const subjects = (rows: readonly AgreementRow[]) => rows.map((r) => r.subject);
const on: SwipeContext = { sender: CTX_OWNER as unknown as SenderContext, online: true };

const discovered = (over: Partial<InboxItem> = {}): InboxItem =>
  received({ id: HANDLE, source: 'discovered', ...over } as Partial<InboxItem>);

describe('W2 — discovered items render exactly like bound ones (rows 1, 3)', () => {
  it('Needs me, pill, line, Home tasks and the Sign swipe are the same for both sources', () => {
    const bound = received({ subject: 'Bound', from: 'Acme', sent_at: SENT_AT });
    const disc = discovered({ subject: 'Discovered', from: 'Acme', sent_at: SENT_AT });
    const rows = mergeAgreements([], inbox({ waiting: [bound, disc] }));
    expect(subjects(filterAgreements(rows, 'needs_me')).sort()).toEqual(['Bound', 'Discovered']);
    const [b, d] = ['Bound', 'Discovered'].map((s) => rows.find((r) => r.subject === s)!);
    expect(pillFor(d!)).toBe(pillFor(b!));
    expect(secondaryLine(d!)).toBe(secondaryLine(b!));
    expect(statusIcon(d!)).toBe('needs');
    expect(swipeActionsFor(d!, on).map((a) => a.kind)).toEqual(['sign']);
    // The handle is passed through unchanged as the Signing route id.
    expect(assignedTasks(rows).map((t) => t.inboxItemId)).toContain(HANDLE);
  });
});

describe('W2 — Upcoming (row 4)', () => {
  const later = discovered({
    subject: 'Second signer',
    my_status: 'upcoming',
    can_sign: false,
  } as Partial<InboxItem>);

  it('an upcoming item is under Upcoming, never Needs me, never Home tasks', () => {
    const rows = mergeAgreements([], inbox({ waiting: [later] }));
    expect(subjects(filterAgreements(rows, 'upcoming'))).toEqual(['Second signer']);
    expect(filterAgreements(rows, 'needs_me')).toEqual([]);
    expect(filterAgreements(rows, 'waiting')).toEqual([]);
    expect(assignedTasks(rows)).toEqual([]);
    expect(pillFor(rows[0]!)).toBe('IN_PROGRESS');
    expect(secondaryLine(rows[0]!)).toBe('Not your turn yet · from Northwind Staffing');
    expect(swipeActionsFor(rows[0]!, on)).toEqual([]);
  });

  it('copy: chip "Upcoming", hint "Not your turn yet", empty state', () => {
    expect(FILTER_LABEL.upcoming).toBe('Upcoming');
    const noFrom = mergeAgreements([], inbox({ waiting: [{ ...later, from: null }] }));
    expect(secondaryLine(noFrom[0]!)).toBe('Not your turn yet');
    expect(EMPTY_STATE.upcoming).toEqual({
      title: 'Nothing upcoming',
      body: 'Envelopes you sign later in the order show up here.',
    });
  });

  it('after signer 1 signs, the same item is in Needs me', () => {
    const now = { ...later, my_status: 'PENDING', can_sign: true } as InboxItem;
    const rows = mergeAgreements([], inbox({ waiting: [now] }));
    expect(subjects(filterAgreements(rows, 'needs_me'))).toEqual(['Second signer']);
    expect(filterAgreements(rows, 'upcoming')).toEqual([]);
  });
});

describe('W2 — self-send dual visibility and "Waiting for you" (rows 1, 2, 5)', () => {
  const mine = sent('SENT', {
    subject: 'Self-sent',
    sent_at: SENT_AT,
    awaiting_you: true,
    my_inbox_item_id: HANDLE,
    recipients: [
      {
        id: 'r1',
        name: 'Pat Sender',
        email: 'pat@example.com',
        status: 'PENDING',
        recipient_kind: 'SIGNER',
      },
    ],
  } as Parameters<typeof sent>[1]);
  const mineReceived = discovered({
    subject: 'Self-sent',
    sent_at: SENT_AT,
    envelope_status: 'SENT',
    i_am_sender: true,
  });

  it('the envelope is both a sent row "Waiting for you" and a received Needs me row (not deduped)', () => {
    const rows = mergeAgreements([mine], inbox({ waiting: [mineReceived] }));
    expect(rows.map((r) => r.kind).sort()).toEqual(['received', 'sent']);
    const s = rows.find((r) => r.kind === 'sent')!;
    expect(secondaryLine(s)).toBe('Waiting for you · 0 of 1 signed');
    expect(pillFor(s)).toBe('NEEDS_ME');
    expect(statusIcon(s)).toBe('needs');
    expect(swipeActionsFor(s, on).map((a) => a.kind)).toEqual(['sign', 'remind', 'void']);
    // Needs me lists the received row once; "Waiting for others" does not list it at all.
    expect(filterAgreements(rows, 'needs_me').map((r) => r.kind)).toEqual(['received']);
    expect(filterAgreements(rows, 'waiting')).toEqual([]);
    expect(homeChips(rows)[0]?.count).toBe(0);
  });

  it('Sign on the sent row uses the server’s my_inbox_item_id; none = open Needs me', () => {
    const row = (e: typeof mine) => mergeAgreements([e], null)[0]!;
    expect(inboxItemToSign(row(mine))).toBe(HANDLE);
    expect(
      inboxItemToSign(row({ ...mine, my_inbox_item_id: 'b0000000-0000-4000-8000-0000000000aa' })),
    ).toBe('b0000000-0000-4000-8000-0000000000aa');
    // awaiting_you with no inbox item for the user: the screen opens Needs me instead.
    expect(inboxItemToSign(row({ ...mine, my_inbox_item_id: null }))).toBeNull();
    // Never derived from another field: not awaiting the user = nothing to sign here.
    expect(inboxItemToSign(row({ ...mine, awaiting_you: false }))).toBeNull();
    expect(inboxItemToSign(row({ ...mine, status: 'COMPLETED' }))).toBeNull();
  });

  it('after I sign with others pending: sender row "Waiting for others"; received row off Needs me (row 5)', () => {
    const after = { ...mine, awaiting_you: false, status: 'IN_PROGRESS' as const };
    const meDone = {
      ...mineReceived,
      my_status: 'SIGNED',
      can_sign: false,
      envelope_status: 'IN_PROGRESS',
    } as InboxItem;
    const rows = mergeAgreements([after], inbox({ other: [meDone] }));
    const s = rows.find((r) => r.kind === 'sent')!;
    expect(secondaryLine(s)).toMatch(/^Waiting for others · /);
    expect(swipeActionsFor(s, on).map((a) => a.kind)).toEqual(['remind', 'void']);
    expect(filterAgreements(rows, 'needs_me')).toEqual([]);
    // R-8: I am also the sender, so the received row I signed counts as waiting too.
    expect(
      filterAgreements(rows, 'waiting')
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['received', 'sent']);
  });
});

describe('W2 — done leaves Needs me; R-8 (row 6)', () => {
  it('a received row I signed (I did not send it) is in the received history, not Waiting', () => {
    const meDone = received({
      subject: 'Their envelope',
      my_status: 'SIGNED',
      can_sign: false,
      envelope_status: 'IN_PROGRESS',
    });
    const rows = mergeAgreements([], inbox({ other: [meDone] }));
    expect(filterAgreements(rows, 'needs_me')).toEqual([]);
    expect(filterAgreements(rows, 'waiting')).toEqual([]);
    // The server's i_am_sender decides (never a match against the sent list).
    const mine = mergeAgreements([], inbox({ other: [{ ...meDone, i_am_sender: true }] }));
    expect(subjects(filterAgreements(mine, 'waiting'))).toEqual(['Their envelope']);
    expect(subjects(filterAgreements(rows, 'all'))).toEqual(['Their envelope']);
    expect(secondaryLine(rows[0]!)).toBe('You signed · waiting for others');
  });
});

describe('W2 — terminal envelopes (row 7)', () => {
  it.each(['COMPLETED', 'VOIDED', 'EXPIRED', 'DECLINED'] as const)(
    '%s is Completed, not signable',
    (status) => {
      const item = discovered({
        envelope_status: status,
        can_sign: false,
        my_status: status === 'COMPLETED' ? 'SIGNED' : 'PENDING',
      });
      const rows = mergeAgreements([], inbox({ other: [item] }));
      expect(filterAgreements(rows, 'done')).toHaveLength(1);
      expect(filterAgreements(rows, 'needs_me')).toEqual([]);
      expect(filterAgreements(rows, 'upcoming')).toEqual([]);
      expect(swipeActionsFor(rows[0]!, on).map((a) => a.kind)).not.toContain('sign');
    },
  );
});

describe('W2 — claimed compatibility and no duplicates within the received list (rows 2, 8)', () => {
  it('an existing claimed (bound) item is listed once and signs by its binding id', () => {
    const claimed = received({ id: 'b0000000-0000-4000-8000-000000000001', subject: 'Claimed' });
    const rows = mergeAgreements([], inbox({ waiting: [claimed], other: [claimed] }));
    expect(rows.filter((r) => r.kind === 'received')).toHaveLength(1);
    expect(countFor(rows, 'needs_me')).toBe(1);
    expect(assignedTasks(rows)[0]?.inboxItemId).toBe('b0000000-0000-4000-8000-000000000001');
  });
});

describe('W2 — a changed discovered item (404 inbox_item_not_found)', () => {
  it('copy', () => {
    expect(refusalMessage({ reason: INBOX_ITEM_NOT_FOUND, code: 'NOT_FOUND' })).toBe(ITEM_CHANGED);
  });

  it('signs by the opaque handle; on 404 the inbox reloads once, no session, no retry', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'x',
          request_id: 'r',
          details: { reason: 'inbox_item_not_found' },
        },
      },
    }));
    const guest = { open: jest.fn() };
    const reload = jest.fn();
    const r = await startInboxSigning(workspace, guest, HANDLE, reload);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe(`${BASE}/v1/sign/inbox/${HANDLE}/sign`);
    expect(r).toEqual({ kind: 'refused', reason: 'inbox_item_not_found', message: ITEM_CHANGED });
    expect(isInboxItemGone(r)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(guest.open).not.toHaveBeenCalled();
  });

  it('a revalidation refusal keeps today’s copy and does not reload', async () => {
    const { workspace } = workspaceWith(() => ({
      status: 409,
      body: { error: { code: 'CONFLICT', details: { reason: 'not_your_turn' } } },
    }));
    const reload = jest.fn();
    const r = await startInboxSigning(workspace, { open: jest.fn() }, HANDLE, reload);
    expect(r).toMatchObject({ kind: 'refused', reason: 'not_your_turn' });
    expect(isInboxItemGone(r)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a valid handle opens the session on the guest transport', async () => {
    const { workspace } = workspaceWith(() => ({
      status: 200,
      body: {
        signing_url: `https://sign.aramo.ai/s/${'a'.repeat(40)}`,
        expires_at: '2026-11-03T10:30:00.000Z',
      },
    }));
    const guest = createGuestSigningClient({
      baseUrl: BASE,
      fetch: recordingFetch(() => ({ status: 200, body: {} })).fetch,
    });
    expect((await startInboxSigning(workspace, guest, HANDLE)).kind).toBe('session');
  });
});

describe('W2 — binding-only actions are hidden for discovered items', () => {
  it('remove, report and the signed copy by item id need a binding', () => {
    expect(hasBindingActions(received())).toBe(true);
    expect(hasBindingActions(discovered())).toBe(false);
  });
});
