import { ApiError } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvelopeRow } from '../api';

// Retention and Purge (DocuSign parity) — Delete moves a terminal envelope to this
// organization's Deleted folder (after a confirm); the Deleted folder lists them with Restore;
// a scheduled or executed purge shows as a tag.

const list = vi.fn();
const del = vi.fn();
const restore = vi.fn();
const detail = vi.fn();
const selfSign = vi.fn();
const navigate = vi.fn();
const inboxSign = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const mod = await orig<typeof import('react-router-dom')>();
  return { ...mod, useNavigate: () => navigate };
});
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    senderApi: {
      ...mod.senderApi,
      list: (...a: unknown[]) => list(...a),
      deleteEnvelope: (...a: unknown[]) => del(...a),
      restoreEnvelope: (...a: unknown[]) => restore(...a),
      detail: (...a: unknown[]) => detail(...a),
      selfSignSession: (...a: unknown[]) => selfSign(...a),
    },
    inboxApi: { ...mod.inboxApi, sign: (...a: unknown[]) => inboxSign(...a) },
  };
});
const toast = vi.fn();
vi.mock('../workspace', () => ({
  useWorkspace: () => ({ base: '/sign', ctx: { can_send: true }, toast, refreshCounts: vi.fn() }),
}));

import { EnvelopeList } from './EnvelopeList';

function row(id: string, over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    id, subject: `Agreement ${id}`, status: 'COMPLETED', created_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-02T00:00:00Z',
    last_activity_at: '2026-10-02T00:00:00Z', document_count: 1, recipients: [], ...over,
  };
}
function show(folder?: 'deleted') {
  render(
    <MemoryRouter>
      <EnvelopeList {...(folder !== undefined ? { folder } : {})} />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('Envelope list — Deleted folder', () => {
  it('offers Delete only on terminal envelopes and confirms before moving one to Deleted', async () => {
    list.mockResolvedValue({ items: [row('a'), row('b', { status: 'IN_PROGRESS', completed_at: null })], counts: { COMPLETED: 1, IN_PROGRESS: 1 } });
    del.mockResolvedValue({ deleted: true });
    show();
    expect(await screen.findByTestId('delete-a')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-b')).toBeNull();
    fireEvent.click(screen.getByTestId('delete-a'));
    expect(await screen.findByText(/hidden for your organization only/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-envelope-action'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Moved to Deleted'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('lists the Deleted folder with Restore, and never offers Restore after a purge ran', async () => {
    list.mockResolvedValue({
      items: [row('c'), row('d', { purge: { state: 'EXECUTED', level: 'DOCUMENTS', due_at: null, executed_at: '2026-10-30T00:00:00Z' } })],
      counts: { COMPLETED: 2 },
    });
    restore.mockResolvedValue({ restored: true });
    show('deleted');
    expect(await screen.findByRole('heading', { name: 'Deleted' })).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ folder: 'deleted' })));
    expect(await screen.findByTestId('restore-c')).toBeInTheDocument();
    expect(screen.queryByTestId('restore-d')).toBeNull();
    expect(screen.queryByTestId('delete-c')).toBeNull();
    expect(screen.getByText('Purged')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restore-c'));
    fireEvent.click(await screen.findByTestId('confirm-envelope-action'));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('c'));
  });

  it('tags an envelope whose purge is scheduled', async () => {
    list.mockResolvedValue({ items: [row('e', { purge: { state: 'QUEUED', level: 'DOCUMENTS', due_at: '2026-11-14T00:00:00Z', executed_at: null } })], counts: { COMPLETED: 1 } });
    show();
    expect(await screen.findByTestId('purge-tag')).toHaveTextContent('Purge scheduled');
  });
});

// W2 (A3.5, A5 rows 1, 2, 5) — "Waiting for you" when only the sender's own step remains.
describe('Envelope list — Waiting for you', () => {
  const open = (id: string, over: Partial<EnvelopeRow> = {}) => row(id, { status: 'SENT', completed_at: null, ...over });

  it('labels an awaiting_you envelope "Waiting for you" with Sign; others keep their status (rows 1, 5)', async () => {
    list.mockResolvedValue({ items: [open('me', { awaiting_you: true }), open('them', { awaiting_you: false }), open('old')], counts: { SENT: 3 } });
    show();
    expect(await screen.findByTestId('awaiting-you-me')).toHaveTextContent('Waiting for you');
    expect(screen.getByTestId('sign-me')).toBeInTheDocument();
    for (const id of ['them', 'old']) {
      expect(screen.queryByTestId(`awaiting-you-${id}`)).toBeNull();
      expect(screen.queryByTestId(`sign-${id}`)).toBeNull();
    }
    expect(screen.getAllByTestId('status-pill').map((p) => p.textContent)).toEqual(['Sent', 'Sent']);
  });

  it('Sign opens the server’s my_inbox_item_id through inbox signing (rows 1, 2)', async () => {
    list.mockResolvedValue({ items: [open('me', { awaiting_you: true, my_inbox_item_id: 'opaque-handle-1' })], counts: { SENT: 1 } });
    inboxSign.mockResolvedValue({ signing_url: 'https://sign.example/s/tok-i', expires_at: '2026-11-03T01:00:00Z' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    show();
    fireEvent.click(await screen.findByTestId('sign-me'));
    await waitFor(() => expect(inboxSign).toHaveBeenCalledWith('opaque-handle-1'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://sign.example/s/tok-i'));
    expect(detail).not.toHaveBeenCalled();
    expect(selfSign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a changed inbox item says so and opens the inbox', async () => {
    list.mockResolvedValue({ items: [open('me', { awaiting_you: true, my_inbox_item_id: 'stale' })], counts: { SENT: 1 } });
    inboxSign.mockRejectedValue(new ApiError(404, 'Not in your inbox', 'NOT_FOUND', { reason: 'inbox_item_not_found' }));
    show();
    fireEvent.click(await screen.findByTestId('sign-me'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This item changed. Showing your latest inbox.'));
    expect(navigate).toHaveBeenCalledWith('/sign/inbox');
  });

  it('without my_inbox_item_id, Sign uses Sign now for a recipient assigned to the sender (row 2)', async () => {
    list.mockResolvedValue({ items: [open('me', { awaiting_you: true })], counts: { SENT: 1 } });
    detail.mockResolvedValue({ recipients: [{ id: 'r-other', assigned_to_me: false, can_remind: false }, { id: 'r-me', assigned_to_me: true, can_remind: true }] });
    selfSign.mockResolvedValue({ session_origin: 'SELF', signer_id: 'r-me', token: 'tok-1', expires_at: '2026-11-03T01:00:00Z' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    show();
    fireEvent.click(await screen.findByTestId('sign-me'));
    await waitFor(() => expect(selfSign).toHaveBeenCalledWith('me', 'r-me'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/s/tok-1'));
    expect(navigate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('without my_inbox_item_id or an assigned recipient, Sign opens the "Waiting for me" inbox (row 1)', async () => {
    list.mockResolvedValue({ items: [open('me', { awaiting_you: true, my_inbox_item_id: null })], counts: { SENT: 1 } });
    detail.mockResolvedValue({ recipients: [{ id: 'r-typed', assigned_to_me: false, can_remind: true }] });
    show();
    fireEvent.click(await screen.findByTestId('sign-me'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/sign/inbox'));
    expect(selfSign).not.toHaveBeenCalled();
  });
});
