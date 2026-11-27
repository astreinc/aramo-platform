// Agreements swipe actions by state (M-A4 §3.5–§3.7) and the list actions that read the
// envelope detail first (editable / sender / can_remind).
import type { LocalDraft } from '../../../state/draftStore';
import { mergeAgreements, type AgreementRow } from '../agreementsModel';
import {
  checkEditable,
  ENVELOPE_CHANGED,
  NOT_EDITABLE,
  NOT_MANAGEABLE,
  NOTHING_TO_REMIND,
  remindFromList,
  voidFromList,
} from '../listActions';
import { NO_INBOX_ACTIONS, NO_SENDER_ACTIONS } from '@aramo/sign-client';

import { swipeActionsFor, type SwipeContext } from '../rowActionRules';
import {
  ENVELOPE_STATUSES,
  type InboxItem,
  type SenderContext,
  type SenderListItem,
} from '../types';
import { CTX_OWNER, detail, received, sent, workspaceWith } from './fixtures';

const owner = CTX_OWNER as unknown as SenderContext;
const on: SwipeContext = { sender: owner, online: true };

const sentRow = (e: SenderListItem): AgreementRow => mergeAgreements([e], null)[0]!;
const recvRow = (i: InboxItem): AgreementRow =>
  mergeAgreements([], { waiting: [], completed: [], other: [i] })[0]!;
const kinds = (row: AgreementRow, ctx: SwipeContext = on) =>
  swipeActionsFor(row, ctx).map((a) => a.kind);

describe('swipeActionsFor (state + server permissions)', () => {
  it('sent rows by status', () => {
    const expected: Record<string, string[]> = {
      DRAFT: ['edit', 'delete'],
      SENT: ['remind', 'void'],
      IN_PROGRESS: ['remind', 'void'],
      COMPLETED: ['share'],
      DECLINED: [],
      VOIDED: [],
      EXPIRED: [],
    };
    for (const s of ENVELOPE_STATUSES) expect(kinds(sentRow(sent(s)))).toEqual(expected[s]);
  });

  // APP-DELETED-1 (UAT DEL-09) — Delete to the Deleted folder only when the server's actions.delete.
  it('a finished sent envelope offers Delete (trash) when the server allows it; an open one never', () => {
    const done = sent('COMPLETED');
    const allowed = sentRow({ ...done, actions: { ...done.actions!, delete: true } });
    expect(kinds(allowed)).toEqual(['share', 'trash']);
    expect(swipeActionsFor(allowed, on).find((a) => a.kind === 'trash')).toMatchObject({ label: 'Delete', tone: 'destructive' });
    for (const s of ['DECLINED', 'VOIDED', 'EXPIRED'] as const) {
      const e = sent(s);
      expect(kinds(sentRow({ ...e, actions: { ...e.actions!, delete: true } }))).toEqual(['trash']);
    }
    // A waiting envelope: the server says no (DEL-09 Part C), so no Delete.
    expect(kinds(sentRow(sent('IN_PROGRESS')))).not.toContain('trash');
    expect(kinds(allowed, { ...on, online: false })).toEqual([]);
  });

  it('Needs me = Sign, fed only by the inbox `can_sign`', () => {
    expect(kinds(recvRow(received({ can_sign: true })))).toEqual(['sign']);
    expect(kinds(recvRow(received({ can_sign: false, my_status: 'PENDING' })))).toEqual([]);
  });

  it('received Share only for COMPLETED + can_download; never declined / voided / expired', () => {
    const done = {
      envelope_status: 'COMPLETED' as const,
      can_sign: false,
      my_status: 'SIGNED' as const,
    };
    expect(kinds(recvRow(received({ ...done, can_download: true })))).toEqual(['share']);
    expect(kinds(recvRow(received({ ...done, can_download: false })))).toEqual([]);
    for (const s of ['DECLINED', 'VOIDED', 'EXPIRED'] as const)
      expect(
        kinds(recvRow(received({ envelope_status: s, can_sign: false, can_download: true }))),
      ).toEqual([]);
  });

  it('a received row never gets sender actions (remind / void / edit / delete)', () => {
    for (const s of ENVELOPE_STATUSES) {
      const k = kinds(
        recvRow(received({ envelope_status: s, can_sign: false, can_download: true })),
      );
      expect(k.filter((x) => x !== 'share')).toEqual([]);
    }
  });

  it('an envelope from another application has no Remind / Void / Edit / Delete', () => {
    expect(kinds(sentRow(sent('IN_PROGRESS', { source_application: 'aramo-ats' })))).toEqual([]);
    expect(kinds(sentRow(sent('DRAFT', { source_application: 'aramo-ats' })))).toEqual([]);
  });

  // C3 (audit rows 3, 5, 9, 10, 12) — the swipes are the server's row actions, never derived.
  it('the server decides: a row it allows nothing on has no swipe, whatever its status', () => {
    expect(kinds(sentRow(sent('IN_PROGRESS', { actions: { ...NO_SENDER_ACTIONS } })))).toEqual([]);
    expect(kinds(sentRow(sent('DRAFT', { actions: { ...NO_SENDER_ACTIONS } })))).toEqual([]);
    expect(kinds(recvRow(received({ can_sign: true, actions: { ...NO_INBOX_ACTIONS } })))).toEqual([]);
    // An older server without `actions` allows nothing either.
    expect(kinds(sentRow(sent('IN_PROGRESS', { actions: undefined })))).toEqual([]);
  });

  it('each swipe follows its own key (sign, remind without void, void without remind)', () => {
    expect(kinds(sentRow(sent('IN_PROGRESS', { actions: { ...NO_SENDER_ACTIONS, sign: true, void: true } })))).toEqual(['sign', 'void']);
    expect(kinds(sentRow(sent('SENT', { actions: { ...NO_SENDER_ACTIONS, remind: true } })))).toEqual(['remind']);
    // A Sign Admin's swipe on someone else's draft: the server says edit and delete_draft.
    expect(kinds(sentRow(sent('DRAFT', { actions: { ...NO_SENDER_ACTIONS, edit: true, send: true, delete_draft: true } })))).toEqual(['edit', 'delete']);
  });

  it('offline: only an on-device draft keeps its actions', () => {
    const local: LocalDraft = {
      localId: 'l1',
      envelopeId: null,
      baseRevision: null,
      step: 'documents',
      updatedAt: '2026-10-09T00:00:00.000Z',
      payload: {},
    };
    const localRow = mergeAgreements(null, null, [local])[0]!;
    const off = { sender: owner, online: false };
    expect(kinds(localRow, off)).toEqual(['edit', 'delete']);
    expect(kinds(sentRow(sent('IN_PROGRESS')), off)).toEqual([]);
    expect(kinds(recvRow(received({ can_sign: true })), off)).toEqual([]);
  });
});

describe('list actions read the detail first', () => {
  const ID = 'e5000000-0000-4000-8000-0000000000a1';
  const etag = { ETag: `"${ID}.3"` };

  it('remind: one reminder to the only remindable signer, with an Idempotency-Key', async () => {
    const { net, workspace } = workspaceWith((req) =>
      req.method === 'GET'
        ? { status: 200, body: detail(), headers: etag }
        : { status: 200, body: detail(), headers: etag },
    );
    const r = await remindFromList(workspace, ID);
    expect(r.kind).toBe('sent');
    expect(net.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(net.calls[1]!.url).toMatch(/\/remind$/);
    expect(net.calls[1]!.body).toEqual({ signer_id: 's1' });
    expect(net.calls[1]!.headers['Idempotency-Key']).toBeTruthy();
  });

  it('remind (UAT SND-23): voided elsewhere -> "stale" with the change copy, no remind call', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: detail({ status: 'VOIDED' }), headers: etag }));
    expect(await remindFromList(workspace, ID)).toEqual({ kind: 'stale', message: ENVELOPE_CHANGED });
    expect(net.calls).toHaveLength(1);
  });

  it('remind (UAT SND-23): the server refuses as changed after the read -> "stale"', async () => {
    const { workspace } = workspaceWith((req) =>
      req.method === 'GET'
        ? { status: 200, body: detail(), headers: etag }
        : { status: 409, body: { error: { code: 'ESIGN_REMINDER_NOT_ALLOWED', message: 'envelope status VOIDED is not remindable' } } },
    );
    expect(await remindFromList(workspace, ID)).toEqual({ kind: 'stale', message: ENVELOPE_CHANGED });
  });

  it('remind: refused without calling remind when the detail says not the owner', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 200,
      body: detail({ sender: { id: 'other', name: 'X' } }),
    }));
    expect(await remindFromList(workspace, ID)).toEqual({
      kind: 'refused',
      message: NOT_MANAGEABLE,
    });
    expect(net.calls).toHaveLength(1);
  });

  it('remind: nobody remindable -> the exact next time, or nothing to remind', async () => {
    const cooling = detail({
      recipients: [
        { ...detail().recipients[0]!, reminder_available_at: '2026-10-27T15:00:00.000Z' },
      ],
    });
    const a = workspaceWith(() => ({ status: 200, body: cooling }));
    const r1 = await remindFromList(a.workspace, ID, Date.parse('2026-10-27T14:00:00.000Z'));
    expect(r1.kind === 'refused' && r1.message).toMatch(/^You can send another reminder at /);
    const none = detail({ recipients: [{ ...detail().recipients[0]!, can_remind: false }] });
    const b = workspaceWith(() => ({ status: 200, body: none }));
    expect(await remindFromList(b.workspace, ID)).toEqual({
      kind: 'refused',
      message: NOTHING_TO_REMIND,
    });
    expect(a.net.calls).toHaveLength(1);
  });

  it('void: uses the fresh ETag; a 412 is "stale" (never resubmitted)', async () => {
    const { net, workspace } = workspaceWith((req) =>
      req.method === 'GET'
        ? { status: 200, body: detail(), headers: etag }
        : {
            status: 412,
            body: { error: { code: 'revision_mismatch', reason: 'revision_mismatch' } },
          },
    );
    const r = await voidFromList(workspace, ID, 'Wrong file');
    expect(r.kind).toBe('stale');
    expect(net.calls[1]!.headers['If-Match']).toBe(`"${ID}.3"`);
    expect(net.calls[1]!.body).toEqual({ reason: 'Wrong file' });
    expect(net.calls).toHaveLength(2);
  });

  it('void: refused before any write when the detail does not allow it', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 200,
      body: detail({ status: 'COMPLETED' }),
    }));
    expect(await voidFromList(workspace, ID, 'reason')).toEqual({
      kind: 'refused',
      message: NOT_MANAGEABLE,
    });
    expect(net.calls).toHaveLength(1);
  });

  it('edit follows the server’s actions.edit (C3), not `editable`', async () => {
    const yes = workspaceWith(() => ({
      status: 200,
      body: detail({ status: 'DRAFT', editable: false }),
    }));
    expect(await checkEditable(yes.workspace, ID)).toEqual({ kind: 'editable' });
    const no = workspaceWith(() => ({
      status: 200,
      body: detail({ status: 'DRAFT', editable: true, actions: { ...NO_SENDER_ACTIONS } }),
    }));
    expect(await checkEditable(no.workspace, ID)).toEqual({
      kind: 'refused',
      message: NOT_EDITABLE,
    });
  });
});
