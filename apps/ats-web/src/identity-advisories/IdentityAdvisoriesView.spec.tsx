import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdvisories } from './identity-advisories-api';
import { IdentityAdvisoriesView } from './IdentityAdvisoriesView';
import type { AdvisoryListItem, AdvisoryPage, AdvisoryStatus } from './types';

// The worklist talks to one api module (the enriched keyset list) + reuses the
// sourcing resolve POSTs via the shared dialog. Both are mocked (vitest hoists
// vi.mock above these imports) so the spec asserts the FE behaviour — pair
// names, basis, named kinds, keyset, tab refetch — without a server. ATI-SEP-1
// T10 WP2: the advisories are the ATS-local duplicate advisories.
vi.mock('./identity-advisories-api', () => ({
  getAdvisories: vi.fn(),
}));
vi.mock('../sourcing/sourcing-api', () => ({
  approveAdvisory: vi.fn(),
  dismissAdvisory: vi.fn(),
}));

const REVIEWER = makeSession(['identity:resolve']);

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function item(over: Partial<AdvisoryListItem> = {}): AdvisoryListItem {
  return {
    id: 'adv-1',
    tenant_id: 't',
    talent_record_a_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    talent_record_a_name: 'Ada Lovelace',
    talent_record_b_id: 'bbbbbbbb-5555-6666-7777-888888888888',
    talent_record_b_name: 'Ada King',
    sourced_talent_id: null,
    sourced_talent_name: null,
    basis: 'EMAIL',
    status: 'PENDING_REVIEW',
    created_at: '2026-07-02T10:30:00Z',
    shared_anchor_kinds: ['EMAIL', 'PHONE'],
    ...over,
  };
}

function page(items: readonly AdvisoryListItem[], next: string | null): AdvisoryPage {
  return { items, next_cursor: next };
}

function renderView(session: Session = REVIEWER) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <IdentityAdvisoriesView sessionOverride={session} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // useSession() still runs; stub fetch so it settles quietly (sessionOverride wins).
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no session in test')));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('IdentityAdvisoriesView — reviewer worklist', () => {
  it('renders a pending pair advisory with names, basis + named shared kinds', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(page([item()], null));
    renderView();
    expect(await screen.findByText('Ada Lovelace ↔ Ada King')).toBeInTheDocument();
    expect(screen.getByText('Shared email')).toBeInTheDocument();
    expect(screen.getByText('EMAIL, PHONE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve merge' })).toBeInTheDocument();
    // Default fetch is the pending tab.
    expect(vi.mocked(getAdvisories).mock.calls[0][0]).toMatchObject({
      status: 'PENDING_REVIEW',
    });
  });

  it('renders a sourced-arrival advisory with the arrival side marked', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(
      page(
        [
          item({
            talent_record_b_id: null,
            talent_record_b_name: null,
            sourced_talent_id: 'ssssssss-0000-1111-2222-333333333333',
            sourced_talent_name: 'Ada L.',
            basis: 'SOURCED_ARRIVAL',
            shared_anchor_kinds: ['PHONE'],
          }),
        ],
        null,
      ),
    );
    renderView();
    expect(await screen.findByText('Ada Lovelace ↔ Ada L. (sourced)')).toBeInTheDocument();
    expect(screen.getByText('Sourced arrival')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Same person' })).toBeInTheDocument();
  });

  it('empty tab shows the calm empty copy', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(page([], null));
    renderView();
    expect(await screen.findByText('No advisories in this tab.')).toBeInTheDocument();
  });

  it('keyset "Load more" appends the next page and hides when next_cursor is null', async () => {
    vi.mocked(getAdvisories)
      .mockResolvedValueOnce(page([item({ id: 'adv-1' })], 'cur-1'))
      .mockResolvedValueOnce(
        page([item({ id: 'adv-2', talent_record_a_id: 'cccccccc-0000-1111-2222-333333333333', talent_record_a_name: null })], null),
      );
    renderView();

    await screen.findByText('Ada Lovelace ↔ Ada King');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('cccccccc… ↔ Ada King')).toBeInTheDocument();
    expect(vi.mocked(getAdvisories).mock.calls[1][0]).toMatchObject({
      status: 'PENDING_REVIEW',
      cursor: 'cur-1',
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull(),
    );
  });

  it('switching to a status tab refetches from cursor=none with the new status', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(page([item()], null));
    renderView();
    await screen.findByText('Ada Lovelace ↔ Ada King');
    expect(vi.mocked(getAdvisories)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Approved' }));

    await waitFor(() => expect(vi.mocked(getAdvisories)).toHaveBeenCalledTimes(2));
    const lastCall = vi.mocked(getAdvisories).mock.calls.at(-1)?.[0] as {
      status: AdvisoryStatus;
      cursor?: string;
    };
    expect(lastCall.status).toBe('APPROVED');
    expect(lastCall.cursor).toBeUndefined();
  });

  it('R10: renders NO score/rank/tier/rating text anywhere', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(page([item()], null));
    const { container } = renderView();
    await screen.findByText('Ada Lovelace ↔ Ada King');
    expect(container.textContent ?? '').not.toMatch(/score|rank|tier|rating/i);
  });
});
