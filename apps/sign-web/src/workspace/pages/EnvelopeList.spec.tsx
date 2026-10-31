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
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    senderApi: {
      ...mod.senderApi,
      list: (...a: unknown[]) => list(...a),
      deleteEnvelope: (...a: unknown[]) => del(...a),
      restoreEnvelope: (...a: unknown[]) => restore(...a),
    },
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
