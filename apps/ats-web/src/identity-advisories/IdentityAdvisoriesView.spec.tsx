import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdvisories } from './identity-advisories-api';
import { IdentityAdvisoriesView } from './IdentityAdvisoriesView';
import type { AdvisoryListItem, AdvisoryPage, AdvisoryStatus } from './types';

// The worklist talks to one api module (the enriched keyset list) + reuses the
// sourcing resolve POSTs via the shared dialog. Both are mocked (vitest hoists
// vi.mock above these imports) so the spec asserts the FE behaviour — bands,
// named kinds, reopen provenance, keyset, tab refetch — without a server.
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
    subject_a_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    subject_b_id: 'bbbbbbbb-5555-6666-7777-888888888888',
    advise_band: 'SELF_ASSERTED',
    has_contradiction: false,
    status: 'PENDING_REVIEW',
    created_at: '2026-07-02T10:30:00Z',
    confirmed_kinds: ['EMAIL'],
    contradiction_kinds: [],
    corroborator_conflict_kinds: [],
    shared_anchor_kinds: ['EMAIL', 'PHONE'],
    reopened_at: null,
    reopened_from_band: null,
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
  it('renders a pending advisory with its band pill, named kinds + contradiction flag', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(
      page([item({ has_contradiction: true, contradiction_kinds: ['PHONE'] })], null),
    );
    renderView();

    // Band as a LABEL, never a number (R10).
    expect(await screen.findByText('Self-asserted')).toBeInTheDocument();
    // Named anchor kinds — shared + confirmed + the contradiction group.
    expect(screen.getByText('Shares: EMAIL, PHONE')).toBeInTheDocument();
    expect(screen.getByText('Confirmed: EMAIL')).toBeInTheDocument();
    expect(screen.getByText('Contradicts: PHONE')).toBeInTheDocument();
    // Contradiction flag.
    expect(screen.getByText('Contradiction')).toBeInTheDocument();
    // Default fetch is the pending tab.
    expect(vi.mocked(getAdvisories).mock.calls[0][0]).toMatchObject({
      status: 'PENDING_REVIEW',
    });
  });

  it('shows the reopen provenance marker when reopened_at is set', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(
      page(
        [
          item({
            reopened_at: '2026-07-05T08:00:00Z',
            reopened_from_band: 'CORROBORATED',
          }),
        ],
        null,
      ),
    );
    renderView();
    expect(await screen.findByText('Reopened from CORROBORATED')).toBeInTheDocument();
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
        page([item({ id: 'adv-2', subject_a_id: 'cccccccc-0000-1111-2222-333333333333' })], null),
      );
    renderView();

    await screen.findByText('aaaaaaaa… ↔ bbbbbbbb…');
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(loadMore);

    expect(await screen.findByText('cccccccc… ↔ bbbbbbbb…')).toBeInTheDocument();
    // Second call carried the cursor.
    expect(vi.mocked(getAdvisories).mock.calls[1][0]).toMatchObject({
      status: 'PENDING_REVIEW',
      cursor: 'cur-1',
    });
    // Last page → the button is gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull(),
    );
  });

  it('switching to a status tab refetches from cursor=none with the new status', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(page([item()], null));
    renderView();
    await screen.findByText('Self-asserted');
    expect(vi.mocked(getAdvisories)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Merged' }));

    await waitFor(() => expect(vi.mocked(getAdvisories)).toHaveBeenCalledTimes(2));
    const lastCall = vi.mocked(getAdvisories).mock.calls.at(-1)?.[0] as {
      status: AdvisoryStatus;
      cursor?: string;
    };
    expect(lastCall.status).toBe('MERGED');
    expect(lastCall.cursor).toBeUndefined();
  });

  it('R10: renders NO score/rank/tier/rating text anywhere', async () => {
    vi.mocked(getAdvisories).mockResolvedValue(
      page(
        [
          item({ has_contradiction: true, contradiction_kinds: ['PHONE'], corroborator_conflict_kinds: ['NAME'] }),
        ],
        null,
      ),
    );
    const { container } = renderView();
    await screen.findByText('Self-asserted');
    expect(container.textContent ?? '').not.toMatch(/score|rank|tier|rating/i);
  });
});
