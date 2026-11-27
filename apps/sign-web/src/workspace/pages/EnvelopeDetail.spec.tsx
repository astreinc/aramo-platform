import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { NO_SENDER_ACTIONS, type SenderActions } from '@aramo/sign-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nextSendTime, type EnvelopeDetail as Detail, type Recipient } from '../api';

// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED §5 — envelope detail shows each
// signer's status, the next signer when signing in order, and a per-signer Remind
// only for a signer the backend says may sign now (can_remind).

const remind = vi.fn();
const selfSign = vi.fn();
const detail = vi.fn();
const evidenceMock = vi.fn(async (): Promise<unknown> => null);
const executed = vi.fn();
const dequeue = vi.fn();
const queuePurge = vi.fn();
let manageAll = false;
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    senderApi: {
      ...mod.senderApi,
      detail: (...a: unknown[]) => detail(...a),
      events: async () => ({ items: [] }),
      evidence: () => evidenceMock(),
      remind: (...a: unknown[]) => remind(...a),
      selfSignSession: (...a: unknown[]) => selfSign(...a),
      executed: (...a: unknown[]) => executed(...a),
      dequeuePurge: (...a: unknown[]) => dequeue(...a),
      queuePurge: (...a: unknown[]) => queuePurge(...a),
    },
  };
});
const toast = vi.fn();
vi.mock('../workspace', () => ({
  useWorkspace: () => ({
    base: '/workspace',
    ctx: { can_send: true, user: { id: 'u-1' }, permissions: { manage_all: manageAll } },
    refreshCounts: vi.fn(),
    toast,
  }),
}));
vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

import { EnvelopeDetail } from './EnvelopeDetail';

function rcp(n: number, over: Partial<Recipient> = {}): Recipient {
  return { id: `s${n}`, name: `Signer ${n}`, email: `s${n}@example.com`, status: 'PENDING', signing_order: n, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, can_remind: false, ...over };
}
// Client Rule Consolidation C3 — the page renders the server's `actions`. These fixtures send
// what sign-service's C1 rules would for the caller u-1 (the sender; manage_all when manageAll):
// the page itself never computes them.
function serverActions(d: Detail): SenderActions {
  const may = d.sender.id === 'u-1' || manageAll;
  const open = d.status === 'SENT' || d.status === 'IN_PROGRESS';
  const purged = d.purge?.state === 'EXECUTED';
  const executed = d.status === 'COMPLETED' && !purged;
  return {
    ...NO_SENDER_ACTIONS,
    void: may && open,
    remind: may && open && d.recipients.some((r) => r.can_remind === true),
    delete: may && ['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'].includes(d.status),
    download: executed,
    certificate: executed,
    sign: open && d.recipients.some((r) => r.assigned_to_me === true && r.can_remind === true),
    purge: manageAll && ['COMPLETED', 'DECLINED', 'VOIDED'].includes(d.status) && !purged,
    dequeue_purge: manageAll && d.purge?.state === 'QUEUED',
  };
}
function env(over: Partial<Detail>): Detail {
  const d: Detail = {
    id: 'env-00000001', subject: 'Agreement', status: 'IN_PROGRESS', created_at: '2026-10-20T00:00:00Z', sent_at: '2026-10-20T00:00:00Z', completed_at: null, declined_at: null, voided_at: null,
    expires_at: null, signing_window_days: 30, sender: { id: 'u-1', name: 'Sender' }, editable: false, documents: [], fields: [], recipients: [], ...over,
  };
  return over.actions !== undefined ? d : { ...d, actions: serverActions(d) };
}
function show() {
  render(
    <MemoryRouter initialEntries={['/workspace/envelopes/env-00000001']}>
      <Routes>
        <Route path="/workspace/envelopes/:id" element={<EnvelopeDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  manageAll = false;
});

describe('EnvelopeDetail — reminder on an envelope changed elsewhere (UAT SND-23)', () => {
  it('says the envelope changed and shows its latest state', async () => {
    const open = env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true })] });
    detail.mockResolvedValueOnce(open).mockResolvedValue(env({ status: 'VOIDED', voided_at: '2026-10-21T00:00:00Z', recipients: [rcp(1)] }));
    remind.mockRejectedValue(new ApiError(409, 'envelope status VOIDED is not remindable', 'ESIGN_REMINDER_NOT_ALLOWED'));
    show();
    fireEvent.click(await screen.findByTestId('remind-s1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This envelope changed. Showing the latest version.'));
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('remind-s1')).toBeNull());
  });

  it('a self-sign refusal is not called a change', async () => {
    detail.mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true })] }));
    remind.mockRejectedValue(new ApiError(409, 'x', 'ESIGN_REMINDER_NOT_ALLOWED', { reason: 'self_sign_no_reminders' }));
    show();
    fireEvent.click(await screen.findByTestId('remind-s1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('A document you sign yourself has no one to remind.'));
    expect(detail).toHaveBeenCalledTimes(1);
  });
});

// UAT SND-14 (field-test batch 1 §4 SND-2, SND-4, SND-A) — can_remind stays true during the
// reminder cooldown; reminder_available_at says when it ends (@aramo/sign-client remindableNow).
describe('EnvelopeDetail — reminder cooldown (UAT SND-14)', () => {
  const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('can_remind true with a future reminder_available_at: Send reminder and Remind are disabled and the note says when', async () => {
    const at = inAnHour();
    detail.mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: at })] }));
    show();
    expect(await screen.findByTestId('send-reminder')).toBeDisabled();
    expect(screen.getByTestId('remind-s1')).toBeDisabled();
    expect(screen.getByTestId('remind-cooling')).toHaveTextContent(`You can send another reminder at ${nextSendTime(at)}.`);
    fireEvent.click(screen.getByTestId('send-reminder'));
    expect(remind).not.toHaveBeenCalled();
  });

  it('no cooldown: enabled and no note', async () => {
    detail.mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: null })] }));
    show();
    expect(await screen.findByTestId('send-reminder')).toBeEnabled();
    expect(screen.getByTestId('remind-s1')).toBeEnabled();
    expect(screen.queryByTestId('remind-cooling')).toBeNull();
  });

  it('one signer cooling, another not: Send reminder stays enabled (it reaches the other), no note; the cooling Remind is disabled', async () => {
    detail.mockResolvedValue(
      env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: inAnHour() }), rcp(2, { can_remind: true, reminder_available_at: null })] }),
    );
    show();
    expect(await screen.findByTestId('send-reminder')).toBeEnabled();
    expect(screen.getByTestId('remind-s1')).toBeDisabled();
    expect(screen.getByTestId('remind-s2')).toBeEnabled();
    expect(screen.queryByTestId('remind-cooling')).toBeNull();
  });

  it('right after a reminder the button is disabled with the time; when the time passes it is enabled again (SND-A)', async () => {
    const soon = new Date(Date.now() + 1500).toISOString();
    detail
      .mockResolvedValueOnce(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: null })] }))
      .mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: soon })] }));
    remind.mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: soon })] }));
    show();
    fireEvent.click(await screen.findByTestId('send-reminder'));
    await waitFor(() => expect(screen.getByTestId('send-reminder')).toBeDisabled());
    expect(screen.getByTestId('remind-cooling')).toHaveTextContent(`You can send another reminder at ${nextSendTime(soon)}.`);
    expect(remind).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('send-reminder')).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByTestId('remind-cooling')).toBeNull();
  });

  it('a 429 (a reminder sent elsewhere) toasts the shared words and reads the envelope again', async () => {
    const at = inAnHour();
    detail
      .mockResolvedValueOnce(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: null })] }))
      .mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true, reminder_available_at: at })] }));
    remind.mockRejectedValue(new ApiError(429, 'x', 'ESIGN_REMINDER_NOT_ALLOWED', { reason: 'reminder_cooldown', retry_at: at }));
    show();
    fireEvent.click(await screen.findByTestId('send-reminder'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`This signer was reminded less than an hour ago. You can send another reminder at ${nextSendTime(at)}.`));
    await waitFor(() => expect(screen.getByTestId('send-reminder')).toBeDisabled());
    expect(detail).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('remind-cooling')).toBeInTheDocument();
  });
});

// Client Rule Consolidation C0-1 — the envelope's expiry is envelope_expires_at; the
// deprecated expires_at (the signing-link lifetime) is never called the envelope's expiry.
describe('EnvelopeDetail — expiry (C0-1)', () => {
  it('shows envelope_expires_at as the expiry and labels the link lifetime', async () => {
    detail.mockResolvedValue(env({ expires_at: '2026-10-27T12:00:00Z', envelope_expires_at: '2026-11-19T12:00:00Z', signing_link_valid_days: 7, recipients: [rcp(1)] }));
    show();
    const meta = await screen.findByTestId('envelope-meta');
    expect(meta).toHaveTextContent('expires Nov 19');
    expect(meta).toHaveTextContent('Signing link valid until Oct 27');
    expect(meta).not.toHaveTextContent('expires Oct 27');
  });

  it('an older server without envelope_expires_at shows no envelope expiry', async () => {
    detail.mockResolvedValue(env({ expires_at: '2026-10-27T12:00:00Z', recipients: [rcp(1)] }));
    show();
    const meta = await screen.findByTestId('envelope-meta');
    expect(meta).not.toHaveTextContent(/· expires/);
    expect(meta).toHaveTextContent('Signing link valid until Oct 27');
  });

  it('a completed envelope shows neither', async () => {
    detail.mockResolvedValue(env({ status: 'COMPLETED', completed_at: '2026-10-21T00:00:00Z', expires_at: '2026-10-27T12:00:00Z', envelope_expires_at: '2026-11-19T12:00:00Z', recipients: [rcp(1, { status: 'SIGNED', signed_at: '2026-10-21T00:00:00Z' })] }));
    show();
    const meta = await screen.findByTestId('envelope-meta');
    expect(meta).not.toHaveTextContent(/expires|Signing link/);
  });
});

describe('EnvelopeDetail — multiple signers', () => {
  it('in order: names the signer whose turn it is and offers Remind only to them', async () => {
    const d = env({ routing_mode: 'SEQUENTIAL', next_signer_id: 's2', recipients: [rcp(1, { status: 'SIGNED', signed_at: '2026-10-20T01:00:00Z' }), rcp(2, { can_remind: true }), rcp(3)] });
    detail.mockResolvedValue(d);
    remind.mockResolvedValue(d);
    show();
    expect(await screen.findByTestId('next-signer')).toHaveTextContent('waiting for Signer 2');
    expect(screen.getByTestId('routing-mode')).toHaveTextContent('In order');
    expect(screen.getByText('1 of 3 signed')).toBeInTheDocument();
    expect(screen.queryByTestId('remind-s1')).toBeNull();
    expect(screen.queryByTestId('remind-s3')).toBeNull();
    fireEvent.click(screen.getByTestId('remind-s2'));
    await waitFor(() => expect(remind).toHaveBeenCalledWith('env-00000001', 's2'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Reminder sent to Signer 2'));
  });

  it('any order: no next-signer line, and every unsigned signer can be reminded', async () => {
    detail.mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true }), rcp(2, { status: 'SIGNED', signed_at: '2026-10-20T01:00:00Z' }), rcp(3, { can_remind: true })] }));
    show();
    expect(await screen.findByTestId('routing-mode')).toHaveTextContent('Any order');
    expect(screen.queryByTestId('next-signer')).toBeNull();
    expect(screen.getByTestId('remind-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('remind-s2')).toBeNull();
    expect(screen.getByTestId('remind-s3')).toBeInTheDocument();
  });
});

// Retention and Purge (DocuSign parity) — the purge banner, Cancel purge for an administrator,
// no downloads once purged, and a 410 ENVELOPE_PURGED download shown plainly.
describe('EnvelopeDetail — retention and purge', () => {
  const done = { status: 'COMPLETED' as const, completed_at: '2026-10-21T00:00:00Z', documents: [{ id: 'd1', title: 'NDA', ordinal: 1, content_type: 'application/pdf', byte_size: 10, source_sha256: 'x', field_count: 1 }] };

  it('a scheduled purge shows its date, and an administrator can cancel it', async () => {
    manageAll = true;
    const queued = env({ ...done, purge: { state: 'QUEUED', level: 'DOCUMENTS', due_at: '2026-11-14T00:00:00Z', executed_at: null } });
    detail.mockResolvedValue(queued);
    // The server's SignEnvelopePurgeResult: { purge } only, never the envelope (UAT DEL-10).
    dequeue.mockResolvedValue({ purge: { state: 'DEQUEUED', level: 'DOCUMENTS', due_at: '2026-11-14T00:00:00Z', executed_at: null } });
    show();
    expect(await screen.findByTestId('purge-banner')).toHaveTextContent('Purge scheduled');
    // C3 — the server's purge action stays true while a purge is queued (it may be raised to a higher level).
    expect(screen.getByTestId('purge-envelope')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-purge'));
    await waitFor(() => expect(dequeue).toHaveBeenCalledWith('env-00000001'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Purge cancelled'));
    // UAT DEL-10 — the page stays rendered (it went blank until a reload).
    expect(screen.getByTestId('purge-envelope')).toBeInTheDocument();
  });

  it('a sender who is not an administrator sees the schedule but cannot cancel or purge', async () => {
    detail.mockResolvedValue(env({ ...done, purge: { state: 'QUEUED', level: 'DOCUMENTS', due_at: '2026-11-14T00:00:00Z', executed_at: null } }));
    show();
    expect(await screen.findByTestId('purge-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-purge')).toBeNull();
    expect(screen.queryByTestId('purge-envelope')).toBeNull();
    expect(screen.getByTestId('delete-envelope')).toBeInTheDocument();
  });

  it('a purged envelope offers no downloads or preview and says the documents are gone', async () => {
    detail.mockResolvedValue(env({ ...done, purge: { state: 'EXECUTED', level: 'DOCUMENTS', due_at: null, executed_at: '2026-10-30T00:00:00Z' } }));
    show();
    expect(await screen.findByTestId('purge-banner')).toHaveTextContent('were purged');
    expect(screen.queryByTestId('download-executed')).toBeNull();
    expect(screen.getByTestId('document-purged')).toBeInTheDocument();
  });

  it('a download refused with ENVELOPE_PURGED (410) explains it', async () => {
    detail.mockResolvedValue(env(done));
    executed.mockRejectedValue(new ApiError(410, 'purged', 'ENVELOPE_PURGED', {}));
    show();
    fireEvent.click(await screen.findByTestId('download-executed'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This envelope’s documents were purged and can’t be downloaded.'));
  });

  it('an administrator queues a purge only after choosing a level and typing PURGE', async () => {
    manageAll = true;
    detail.mockResolvedValue(env(done));
    queuePurge.mockResolvedValue({ purge: { state: 'QUEUED', level: 'DOCUMENTS_AND_METADATA', due_at: '2026-11-14T00:00:00Z', executed_at: null } });
    show();
    fireEvent.click(await screen.findByTestId('purge-envelope'));
    const go = await screen.findByTestId('confirm-purge');
    fireEvent.change(screen.getByLabelText('What is purged'), { target: { value: 'DOCUMENTS_AND_METADATA' } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type PURGE to confirm'), { target: { value: 'PURGE' } });
    // The reload after queueing reads the envelope with its queued purge, as the server returns it.
    detail.mockResolvedValue(env({ ...done, purge: { state: 'QUEUED', level: 'DOCUMENTS_AND_METADATA', due_at: '2026-11-14T00:00:00Z', executed_at: null } }));
    fireEvent.click(go);
    await waitFor(() => expect(queuePurge).toHaveBeenCalledWith('env-00000001', 'DOCUMENTS_AND_METADATA'));
    // UAT DEL-10 — the page stays rendered and shows the schedule at once (no blank page).
    expect(await screen.findByTestId('purge-banner')).toHaveTextContent('Purge scheduled');
    expect(screen.getByTestId('purge-envelope')).toBeInTheDocument();
  });
});

// Web Self-Signing directive W1 (M-A5 §4) — Sign now for the recipient assigned to the caller.
describe('EnvelopeDetail — Sign now', () => {
  const assign = vi.fn();
  const realLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });
  function stubLocation() {
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  }

  it('is offered only on the caller’s own assigned recipient who may sign now, and opens the signing page', async () => {
    stubLocation();
    detail.mockResolvedValue(env({ recipients: [rcp(1, { assigned_to_me: true, can_remind: true }), rcp(2, { can_remind: true })] }));
    selfSign.mockResolvedValue({ session_origin: 'SELF', signer_id: 's1', token: 'tok-abc', expires_at: '2026-11-02T13:00:00Z' });
    show();
    const btn = await screen.findByTestId('sign-now-s1');
    expect(screen.queryByTestId('sign-now-s2')).toBeNull();
    expect(document.body.textContent).not.toContain('tok-abc');
    fireEvent.click(btn);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/s/tok-abc'));
    expect(selfSign).toHaveBeenCalledWith('env-00000001', 's1');
  });

  it('C3 — without the server’s actions.sign, no Sign now even on an assigned recipient', async () => {
    detail.mockResolvedValue(env({ recipients: [rcp(1, { assigned_to_me: true, can_remind: true })], actions: { ...NO_SENDER_ACTIONS, remind: true, void: true } }));
    show();
    expect(await screen.findByTestId('remind-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-now-s1')).toBeNull();
  });

  it('is hidden before the recipient’s turn', async () => {
    detail.mockResolvedValue(env({ routing_mode: 'SEQUENTIAL', next_signer_id: 's2', recipients: [rcp(1, { assigned_to_me: true, can_remind: false }), rcp(2, { can_remind: true })] }));
    show();
    await screen.findByText('0 of 2 signed');
    expect(screen.queryByTestId('sign-now-s1')).toBeNull();
  });

  it('is hidden on a completed envelope', async () => {
    detail.mockResolvedValue(env({ status: 'COMPLETED', recipients: [rcp(1, { assigned_to_me: true, can_remind: true, status: 'SIGNED' })] }));
    show();
    await screen.findByText('1 of 1 signed');
    expect(screen.queryByTestId('sign-now-s1')).toBeNull();
  });

  it('shows the refusal in plain words', async () => {
    detail.mockResolvedValue(env({ recipients: [rcp(1, { assigned_to_me: true, can_remind: true })] }));
    selfSign.mockRejectedValue(new ApiError(403, 'x', 'INSUFFICIENT_PERMISSIONS', { reason: 'email_not_verified' }));
    show();
    fireEvent.click(await screen.findByTestId('sign-now-s1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Your account email isn’t verified, so you can’t sign here. Use the link in the signing email.'));
  });
});

// UAT DEL-09 — an open envelope can't be deleted; Delete is shown disabled with the reason.
describe('EnvelopeDetail — delete an open envelope', () => {
  it('shows Delete disabled with "Finish or void this envelope before deleting it."', async () => {
    detail.mockResolvedValue(env({ routing_mode: 'PARALLEL', next_signer_id: null, recipients: [rcp(1, { can_remind: true })] }));
    show();
    const btn = await screen.findByTestId('delete-envelope-disabled');
    expect(btn).toBeDisabled();
    expect(screen.queryByTestId('delete-envelope')).toBeNull();
    expect(screen.getByTestId('delete-when-finished')).toHaveTextContent('Finish or void this envelope before deleting it.');
  });

  it('a completed envelope keeps the working Delete and no note', async () => {
    detail.mockResolvedValue(env({ status: 'COMPLETED', completed_at: '2026-10-21T00:00:00Z', recipients: [rcp(1, { status: 'SIGNED', signed_at: '2026-10-21T00:00:00Z' })] }));
    show();
    expect(await screen.findByTestId('delete-envelope')).toBeEnabled();
    expect(screen.queryByTestId('delete-when-finished')).toBeNull();
  });
});

// C3 (audit rows 4, 5, 10) — every button follows the server's actions, never status or ownership.
describe('EnvelopeDetail — server-sent actions (C3)', () => {
  it('a read-only member: an open envelope shows no Remind, Void or Delete note', async () => {
    detail.mockResolvedValue(env({ sender: { id: 'u-2', name: 'Other' }, recipients: [rcp(1, { can_remind: true })] }));
    show();
    await screen.findByText('0 of 1 signed');
    for (const id of ['send-reminder', 'void-envelope', 'remind-s1', 'delete-envelope-disabled', 'delete-envelope']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('an older server without actions: nothing is offered, even on a completed envelope', async () => {
    detail.mockResolvedValue({ ...env({ status: 'COMPLETED', completed_at: '2026-10-21T00:00:00Z', recipients: [rcp(1, { status: 'SIGNED' })] }), actions: undefined });
    show();
    await screen.findByText('1 of 1 signed');
    for (const id of ['download-executed', 'delete-envelope', 'purge-envelope']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('a draft the caller may not edit stays on the read-only page (no redirect to the editor)', async () => {
    detail.mockResolvedValue(env({ status: 'DRAFT', sent_at: null, editable: true, actions: { ...NO_SENDER_ACTIONS } }));
    show();
    expect(await screen.findByTestId('envelope-meta')).toBeInTheDocument();
    expect(screen.queryByTestId('void-envelope')).toBeNull();
  });
});

// UAT CMP-05 — the page shows the hash printed on the certificate, in full, with Copy.
describe('EnvelopeDetail — event-chain hash', () => {
  it('shows the certificate’s hash in full (not the chain’s current hash)', async () => {
    const cert = 'OZRYPean_9zNAyTmkHjap1rQR2jCZXPq7Yys3psOofI';
    evidenceMock.mockResolvedValueOnce({ envelope_id: 'env-00000001', status: 'COMPLETED', event_chain_hash: 'XtpcpRJTImvKz6hOcurrentHead', certificate_event_chain_hash: cert, signature: 's', signature_algorithm: 'KMS:RSASSA_PSS_SHA_256', completed_at: '2026-10-21T00:00:00Z' });
    detail.mockResolvedValue(env({ status: 'COMPLETED', completed_at: '2026-10-21T00:00:00Z', recipients: [rcp(1, { status: 'SIGNED', signed_at: '2026-10-21T00:00:00Z' })] }));
    show();
    expect(await screen.findByTestId('evidence-chain-hash')).toHaveTextContent(cert);
    expect(screen.getByTestId('evidence-chain')).not.toHaveTextContent('XtpcpRJTImvKz6hO');
    expect(screen.getByTestId('evidence-chain-copy')).toBeInTheDocument();
  });
});
