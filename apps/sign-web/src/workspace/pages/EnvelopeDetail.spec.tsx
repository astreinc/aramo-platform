import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvelopeDetail as Detail, Recipient } from '../api';

// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED §5 — envelope detail shows each
// signer's status, the next signer when signing in order, and a per-signer Remind
// only for a signer the backend says may sign now (can_remind).

const remind = vi.fn();
const detail = vi.fn();
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    senderApi: {
      ...mod.senderApi,
      detail: (...a: unknown[]) => detail(...a),
      events: async () => ({ items: [] }),
      evidence: async () => null,
      remind: (...a: unknown[]) => remind(...a),
    },
  };
});
const toast = vi.fn();
vi.mock('../workspace', () => ({
  useWorkspace: () => ({
    base: '/workspace',
    ctx: { can_send: true, user: { id: 'u-1' }, permissions: { manage_all: false } },
    refreshCounts: vi.fn(),
    toast,
  }),
}));
vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

import { EnvelopeDetail } from './EnvelopeDetail';

function rcp(n: number, over: Partial<Recipient> = {}): Recipient {
  return { id: `s${n}`, name: `Signer ${n}`, email: `s${n}@example.com`, status: 'PENDING', signing_order: n, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, can_remind: false, ...over };
}
function env(over: Partial<Detail>): Detail {
  return {
    id: 'env-00000001', subject: 'Agreement', status: 'IN_PROGRESS', created_at: '2026-10-20T00:00:00Z', sent_at: '2026-10-20T00:00:00Z', completed_at: null, declined_at: null, voided_at: null,
    expires_at: null, signing_window_days: 30, sender: { id: 'u-1', name: 'Sender' }, editable: false, documents: [], fields: [], recipients: [], ...over,
  };
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

afterEach(() => vi.clearAllMocks());

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
