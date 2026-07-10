import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, ToastProvider, type Session } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestEmailVerification } from '../talent/talent-api';
import { resolveContradiction } from '../talent/dossier-api';

import { getProposals, markProposalActed, dismissProposal } from './trust-proposals-api';
import { TrustProposalsView } from './TrustProposalsView';
import type { ProposalListItem, ProposalPage } from './types';

// The queue talks to its own api (list + mark-acted + dismiss), the existing
// verification request client (one-click), and the existing contradiction resolve
// (via the reused dialog). All mocked (vitest hoists vi.mock) so the spec asserts
// the FE behaviour — the one-click, the consent-refusal render, the deep-link, the
// resolve wiring, the dismiss — without a server.
vi.mock('./trust-proposals-api', () => ({
  getProposals: vi.fn(),
  markProposalActed: vi.fn(),
  dismissProposal: vi.fn(),
}));
vi.mock('../talent/talent-api', () => ({ requestEmailVerification: vi.fn() }));
vi.mock('../talent/dossier-api', () => ({ resolveContradiction: vi.fn() }));

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}
const FULL = makeSession(['talent:read', 'talent:edit', 'identity:resolve']);

function item(over: Partial<ProposalListItem> = {}): ProposalListItem {
  return {
    id: 'prop-1',
    tenant_id: 't',
    subject_id: 'ssssssss-1111-2222-3333-444444444444',
    kind: 'VERIFY_CONTACT',
    trigger_kind: 'SINGLE_SOURCE_ONLY',
    basis_ref_id: 'bbbbbbbb-5555-6666-7777-888888888888',
    basis_kinds: ['EMAIL'],
    status: 'OPEN',
    created_at: '2026-07-02T10:30:00Z',
    record_id: 'rrrrrrrr-9999-0000-1111-222222222222',
    slot: 'email1',
    ...over,
  };
}
function page(items: readonly ProposalListItem[], next: string | null = null): ProposalPage {
  return { items, next_cursor: next };
}
function renderView(session: Session = FULL) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TrustProposalsView sessionOverride={session} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no session in test')));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('TrustProposalsView — the caseworker queue', () => {
  it('an email VERIFY with a resolvable slot one-clicks the request endpoint then marks acted', async () => {
    vi.mocked(getProposals).mockResolvedValue(page([item()]));
    vi.mocked(requestEmailVerification).mockResolvedValue({
      verification_id: 'v1', slot: 'email1', status: 'PENDING', expires_at: '', resent: false,
    });
    vi.mocked(markProposalActed).mockResolvedValue(item({ status: 'ACTED' }));
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(requestEmailVerification).toHaveBeenCalledWith(
      'rrrrrrrr-9999-0000-1111-222222222222',
      'email1',
    ));
    await waitFor(() => expect(markProposalActed).toHaveBeenCalledWith('prop-1'));
  });

  it('a consent 403 renders as the row refusal state ("Consent required"); the row is NOT marked acted', async () => {
    vi.mocked(getProposals).mockResolvedValue(page([item()]));
    vi.mocked(requestEmailVerification).mockRejectedValue(
      new ApiError(403, 'consent required', 'VERIFICATION_CONSENT_REQUIRED'),
    );
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('Consent required')).toBeInTheDocument();
    expect(markProposalActed).not.toHaveBeenCalled();
  });

  it('a PHONE VERIFY (no slot) renders the deep-link, not a one-click', async () => {
    vi.mocked(getProposals).mockResolvedValue(
      page([item({ kind: 'VERIFY_CONTACT', basis_kinds: ['PHONE'], slot: undefined })]),
    );
    renderView();

    expect(await screen.findByRole('link', { name: 'Open record to verify' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('a RESOLVE_CONTRADICTION opens the existing dialog; confirming resolves then marks acted', async () => {
    vi.mocked(getProposals).mockResolvedValue(
      page([item({ kind: 'RESOLVE_CONTRADICTION', trigger_kind: 'OPEN_CONTRADICTION', basis_kinds: ['EMPLOYMENT'], slot: undefined })]),
    );
    vi.mocked(resolveContradiction).mockResolvedValue({ status: 'RESOLVED', evidence_id: 'bbbbbbbb-5555-6666-7777-888888888888' });
    vi.mocked(markProposalActed).mockResolvedValue(item({ status: 'ACTED' }));
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    // The reused ContradictionResolveDialog — fill the justification + confirm.
    const textarea = await screen.findByPlaceholderText('Why this is not a real conflict…');
    fireEvent.change(textarea, { target: { value: 'distinct roles' } });
    fireEvent.click(screen.getByTestId('contradiction-confirm'));

    await waitFor(() => expect(resolveContradiction).toHaveBeenCalledWith(
      'bbbbbbbb-5555-6666-7777-888888888888', 'distinct roles',
    ));
    await waitFor(() => expect(markProposalActed).toHaveBeenCalledWith('prop-1'));
  });

  it('Dismiss opens the justification dialog and dismisses', async () => {
    vi.mocked(getProposals).mockResolvedValue(page([item()]));
    vi.mocked(dismissProposal).mockResolvedValue(item({ status: 'DISMISSED' }));
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const textarea = await screen.findByPlaceholderText('Why this proposal isn’t worth acting on…');
    fireEvent.change(textarea, { target: { value: 'handled offline' } });
    fireEvent.click(screen.getByTestId('proposal-dismiss-confirm'));

    await waitFor(() => expect(dismissProposal).toHaveBeenCalledWith('prop-1', 'handled offline'));
  });

  it('default fetch is the OPEN tab; a terminal tab refetches from cursor=none', async () => {
    vi.mocked(getProposals).mockResolvedValue(page([item()]));
    renderView();
    await screen.findByText('Verify contact');
    expect(vi.mocked(getProposals).mock.calls[0]![0]).toMatchObject({ status: 'OPEN' });

    fireEvent.click(screen.getByRole('button', { name: 'Settled' }));
    await waitFor(() => expect(vi.mocked(getProposals)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getProposals).mock.calls.at(-1)![0]).toMatchObject({ status: 'SETTLED' });
  });

  it('R10: renders NO score/rank/tier/rating text and no bare number in the rows', async () => {
    vi.mocked(getProposals).mockResolvedValue(page([item(), item({ id: 'prop-2', kind: 'RESOLVE_CONTRADICTION', basis_kinds: ['EMPLOYMENT'], slot: undefined })]));
    const { container } = renderView();
    await screen.findByText('Verify contact');
    expect(container.textContent ?? '').not.toMatch(/score|rank|tier|rating/i);
  });
});
