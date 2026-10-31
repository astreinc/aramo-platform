import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RetentionPolicy } from '../api';

// Retention and Purge directive (DocuSign parity) — Settings → Document retention. Keep
// forever is the default; an administrator may purge N days (1–9999) after completion at one
// of three levels, after a warning that it also applies to existing envelopes. A targeted purge
// by email needs PURGE typed. Read-only for anyone the backend marks can_edit=false.

const policy = vi.fn();
const setPolicy = vi.fn();
const targeted = vi.fn();
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    senderApi: {
      ...mod.senderApi,
      retentionPolicy: (...a: unknown[]) => policy(...a),
      setRetentionPolicy: (...a: unknown[]) => setPolicy(...a),
      targetedPurge: (...a: unknown[]) => targeted(...a),
    },
  };
});
const toast = vi.fn();
vi.mock('../workspace', () => ({ useWorkspace: () => ({ base: '/sign', toast }) }));

import { RetentionSection } from './Retention';

const FOREVER: RetentionPolicy = { retention_days: null, purge_level: 'DOCUMENTS', updated_at: null, can_edit: true };

function show() {
  render(
    <MemoryRouter>
      <RetentionSection />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('Document retention', () => {
  it('defaults to keep forever, and saving a period first warns that existing envelopes are affected', async () => {
    policy.mockResolvedValue(FOREVER);
    setPolicy.mockResolvedValue({ ...FOREVER, retention_days: 30, purge_level: 'DOCUMENTS_AND_METADATA', updated_at: '2026-10-31T10:00:00Z' });
    show();
    const mode = await screen.findByLabelText('Keep documents');
    expect(mode).toHaveValue('forever');
    expect(screen.getByTestId('retention-save')).toBeDisabled();
    fireEvent.change(mode, { target: { value: 'days' } });
    fireEvent.change(screen.getByLabelText('Days after completion, decline or void'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('What is purged'), { target: { value: 'DOCUMENTS_AND_METADATA' } });
    fireEvent.click(screen.getByTestId('retention-save'));
    expect(await screen.findByText(/applies to every envelope that is already completed, declined or voided/)).toBeInTheDocument();
    expect(screen.getByTestId('retention-confirm-level')).toHaveTextContent('Documents and details');
    fireEvent.click(screen.getByTestId('retention-confirm'));
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith(30, 'DOCUMENTS_AND_METADATA'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Documents are purged 30 days after completion'));
  });

  it('refuses a period outside 1 to 9999 days', async () => {
    policy.mockResolvedValue(FOREVER);
    show();
    fireEvent.change(await screen.findByLabelText('Keep documents'), { target: { value: 'days' } });
    fireEvent.change(screen.getByLabelText('Days after completion, decline or void'), { target: { value: '10000' } });
    expect(screen.getByText('Enter a whole number from 1 to 9999.')).toBeInTheDocument();
    expect(screen.getByTestId('retention-save')).toBeDisabled();
  });

  it('switching back to keep forever sends null', async () => {
    policy.mockResolvedValue({ ...FOREVER, retention_days: 90 });
    setPolicy.mockResolvedValue(FOREVER);
    show();
    fireEvent.change(await screen.findByLabelText('Keep documents'), { target: { value: 'forever' } });
    fireEvent.click(screen.getByTestId('retention-save'));
    fireEvent.click(await screen.findByTestId('retention-confirm'));
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith(null, 'DOCUMENTS'));
  });

  it('is read-only, with no targeted purge, when the backend says can_edit is false', async () => {
    policy.mockResolvedValue({ ...FOREVER, retention_days: 365, can_edit: false });
    show();
    expect(await screen.findByLabelText('Keep documents')).toBeDisabled();
    expect(screen.queryByTestId('retention-save')).toBeNull();
    expect(screen.queryByTestId('targeted-purge-card')).toBeNull();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('a targeted purge needs a valid email and PURGE typed, then reports how many were queued', async () => {
    policy.mockResolvedValue(FOREVER);
    targeted.mockResolvedValue({ queued: 3 });
    show();
    fireEvent.click(await screen.findByTestId('targeted-purge-open'));
    const go = await screen.findByTestId('targeted-purge-confirm');
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'pat@example.com' } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type PURGE to confirm'), { target: { value: 'PURGE' } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(targeted).toHaveBeenCalledWith('pat@example.com', 'DOCUMENTS_AND_METADATA_AND_REDACT'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('3 envelopes queued for purge'));
  });
});
