// Sender detail actions by state (handoff §1.5, §4.3) + remind / void contracts
// (M-A3 §6, §7).
import { errorFromBody } from '../../../api/errors';
import {
  actionsFor,
  createReminder,
  remindableSigners,
  remindLabel,
  reminderRefusalCopy,
  deleteDraftById,
  deleteDraftEnvelope,
  voidEnvelope,
  voidReasonValid,
} from '../envelopeActions';
import { ENVELOPE_STATUSES, type SenderContext } from '../types';
import { CTX_OWNER, detail, workspaceWith } from './fixtures';

const ctx = CTX_OWNER as unknown as SenderContext;

describe('action visibility by state', () => {
  it.each(ENVELOPE_STATUSES)('%s', (status) => {
    const a = actionsFor(detail({ status, editable: status === 'DRAFT' }), ctx);
    const open = status === 'SENT' || status === 'IN_PROGRESS';
    expect(a.remind).toBe(open);
    expect(a.void).toBe(open);
    expect(a.continueEditing).toBe(status === 'DRAFT');
    expect(a.deleteDraft).toBe(status === 'DRAFT');
    expect(a.viewCertificate).toBe(status === 'COMPLETED');
  });

  it('no remind / void on an envelope the user did not send (without manage_all)', () => {
    const other = detail({ sender: { id: 'someone-else', name: 'X' } });
    expect(actionsFor(other, ctx)).toMatchObject({ remind: false, void: false });
    const manager = {
      ...CTX_OWNER,
      permissions: { ...CTX_OWNER.permissions, manage_all: true },
    } as unknown as SenderContext;
    expect(actionsFor(other, manager)).toMatchObject({ remind: true, void: true });
  });

  it('no remind / void on an envelope from another application (read-only here)', () => {
    expect(actionsFor(detail({ source_application: 'aramo-ats' }), ctx)).toMatchObject({
      remind: false,
      void: false,
    });
  });

  it('continue editing follows the server’s `editable`, not the status alone', () => {
    expect(actionsFor(detail({ status: 'DRAFT', editable: false }), ctx).continueEditing).toBe(
      false,
    );
  });

  it('no actions without a sender context (nothing hidden is exposed)', () => {
    expect(actionsFor(detail(), null)).toMatchObject({ remind: false, void: false });
  });
});

describe('remind', () => {
  it('only signers the server marks remindable and not cooling down', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    const d = detail({
      recipients: [
        {
          ...detail().recipients[0]!,
          id: 'a',
          name: 'A',
          can_remind: true,
          reminder_available_at: null,
        },
        {
          ...detail().recipients[0]!,
          id: 'b',
          name: 'B',
          can_remind: true,
          reminder_available_at: '2026-10-20T12:30:00.000Z',
        },
        { ...detail().recipients[0]!, id: 'c', name: 'C', can_remind: false, status: 'SIGNED' },
      ],
    });
    const r = remindableSigners(d, now);
    expect(r.map((x) => x.id)).toEqual(['a']);
    expect(remindLabel(r)).toBe('Send reminder to A');
    expect(remindLabel([r[0]!, r[0]!])).toBe('Send reminder to 2 signers');
  });

  it('sends an Idempotency-Key and reuses it when the same intent is retried', async () => {
    let attempt = 0;
    const { net, workspace } = workspaceWith(() => {
      attempt += 1;
      return attempt === 1
        ? { status: 503, body: {} }
        : { status: 200, body: detail(), headers: { ETag: '"e.4"' } };
    });
    const r = createReminder(workspace, 'e1', 's1');
    await expect(r.send()).rejects.toBeTruthy();
    const ok = await r.send();
    expect(ok.etag).toBe('"e.4"');
    expect(net.calls).toHaveLength(2);
    const k1 = net.calls[0]!.headers['Idempotency-Key'];
    expect(k1).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(net.calls[1]!.headers['Idempotency-Key']).toBe(k1);
    expect(net.calls[0]!.body).toEqual({ signer_id: 's1' });
    // A new user action gets a new key.
    expect(createReminder(workspace, 'e1').key).not.toBe(r.key);
  });

  it('429 shows the exact retry time from the server', () => {
    const e = errorFromBody(429, {
      error: {
        code: 'ESIGN_REMINDER_NOT_ALLOWED',
        details: {
          reason: 'reminder_cooldown',
          retry_after_seconds: 1800,
          retry_at: '2026-10-20T15:30:00.000Z',
        },
      },
    });
    const copy = reminderRefusalCopy(e);
    expect(copy).toContain('less than an hour ago');
    expect(copy).toContain('You can send another reminder at Oct 20, 2026');
    const daily = errorFromBody(429, {
      error: {
        code: 'X',
        details: { reason: 'reminder_daily_limit', retry_at: '2026-10-21T09:00:00.000Z' },
      },
    });
    expect(reminderRefusalCopy(daily)).toContain('most reminders allowed in 24 hours');
  });
});

describe('void', () => {
  it('requires a 3+ character reason', () => {
    expect(voidReasonValid('no')).toBe(false);
    expect(voidReasonValid('  wrong doc ')).toBe(true);
  });

  it('sends If-Match with the last-read ETag', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 200,
      body: detail({ status: 'VOIDED' }),
      headers: { ETag: '"e.4"' },
    }));
    const r = await voidEnvelope(
      workspace,
      { detail: detail(), etag: '"e5000000-0000-4000-8000-0000000000a1.3"' },
      ' Wrong file ',
    );
    expect(r.kind).toBe('voided');
    expect(net.calls[0]!.headers['If-Match']).toBe('"e5000000-0000-4000-8000-0000000000a1.3"');
    expect(net.calls[0]!.body).toEqual({ reason: 'Wrong file' });
  });

  it('falls back to {id, revision} when no ETag was kept', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: detail() }));
    await voidEnvelope(workspace, { detail: detail({ revision: 7 }), etag: null }, 'reason');
    expect(net.calls[0]!.headers['If-Match']).toBe('"e5000000-0000-4000-8000-0000000000a1.7"');
  });

  it('412 revision_mismatch is "stale" (refresh, never resubmit)', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 412,
      body: {
        error: {
          code: 'PRECONDITION_FAILED',
          details: { reason: 'revision_mismatch', current_revision: 5 },
        },
      },
    }));
    const r = await voidEnvelope(workspace, { detail: detail(), etag: '"x.3"' }, 'reason');
    expect(r.kind).toBe('stale');
    expect(net.calls).toHaveLength(1);
  });
});

describe('delete draft (D-W6-3)', () => {
  const ID = 'e5000000-0000-4000-8000-0000000000a1';
  const draft = (over = {}) => detail({ status: 'DRAFT', editable: true, revision: 4, ...over });
  const stale = {
    status: 412,
    body: { error: { code: 'PRECONDITION_FAILED', details: { reason: 'revision_mismatch', current_revision: 5 } } },
  };

  it('DELETEs the draft with the last-read ETag', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 204, body: null }));
    const r = await deleteDraftEnvelope(workspace, { detail: draft(), etag: `"${ID}.4"` });
    expect(r.kind).toBe('deleted');
    expect(net.calls[0]!.method).toBe('DELETE');
    expect(net.calls[0]!.url).toMatch(new RegExp(`/v1/sign/sender/envelopes/${ID}$`));
    expect(net.calls[0]!.headers['If-Match']).toBe(`"${ID}.4"`);
  });

  it('never calls the server for a sent envelope or one not editable here', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 204, body: null }));
    expect((await deleteDraftEnvelope(workspace, { detail: detail({ status: 'SENT' }), etag: null })).kind).toBe('refused');
    expect((await deleteDraftEnvelope(workspace, { detail: draft({ editable: false }), etag: null })).kind).toBe('refused');
    expect(net.calls).toHaveLength(0);
  });

  it('412 is "stale" from the detail screen (refresh, never resubmit)', async () => {
    const { net, workspace } = workspaceWith(() => stale);
    const r = await deleteDraftEnvelope(workspace, { detail: draft(), etag: '"x.3"' });
    expect(r.kind).toBe('stale');
    expect(net.calls).toHaveLength(1);
  });

  it('from the list: reads the ETag, deletes, and re-reads once after a 412', async () => {
    let deletes = 0;
    const { net, workspace } = workspaceWith((req) => {
      if (req.method === 'GET') return { status: 200, body: draft(), headers: { ETag: `"${ID}.${4 + deletes}"` } };
      deletes += 1;
      return deletes === 1 ? stale : { status: 204, body: null };
    });
    const r = await deleteDraftById(workspace, ID);
    expect(r.kind).toBe('deleted');
    expect(net.calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET', 'DELETE']);
    expect(net.calls[3]!.headers['If-Match']).toBe(`"${ID}.5"`);
  });

  it('from the list: a second 412 is reported, not retried again', async () => {
    const { net, workspace } = workspaceWith((req) =>
      req.method === 'GET' ? { status: 200, body: draft(), headers: { ETag: `"${ID}.4"` } } : stale,
    );
    expect((await deleteDraftById(workspace, ID)).kind).toBe('stale');
    expect(net.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });
});

