import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listRequisitions } from '../requisitions/requisitions-api';

import {
  addToPipeline,
  approveAdvisory,
  getPool,
  getSubjectDetail,
  saveToBench,
} from './sourcing-api';
import { SourcingPoolView } from './SourcingPoolView';
import type { PoolPage, SubjectDetail } from './types';

// The sourcing surface talks to two api modules; both are mocked (vitest hoists
// vi.mock above these imports) so the specs assert the FE behaviour (rows,
// keyset, promote mapping, advisory gating) without a server. ATI-SEP-1 T10 WP2:
// the pool is sourced arrivals on ATS data — no trust bands on the wire.
vi.mock('./sourcing-api', () => ({
  getPool: vi.fn(),
  getSubjectDetail: vi.fn(),
  addToPipeline: vi.fn(),
  saveToBench: vi.fn(),
  approveAdvisory: vi.fn(),
  dismissAdvisory: vi.fn(),
  reverseAdvisory: vi.fn(),
}));
vi.mock('../requisitions/requisitions-api', () => ({
  listRequisitions: vi.fn(),
}));

const SOURCER = makeSession(['talent:source', 'identity:resolve']);
const SOURCER_NO_RESOLVE = makeSession(['talent:source']);

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function page(items: PoolPage['items'], next: string | null): PoolPage {
  return { items, next_cursor: next };
}

function item(over: Partial<PoolPage['items'][number]> = {}): PoolPage['items'][number] {
  return {
    subject_id: 's1',
    display_name: 'Ada Lovelace',
    email: 'ada@x.com',
    phone: '5551230000',
    source_channel: 'INDEED',
    arrived_at: '2026-07-01T00:00:00Z',
    open_advisory_count: 0,
    ...over,
  };
}

function detail(over: Partial<SubjectDetail> = {}): SubjectDetail {
  return {
    subject_id: 's1',
    display_name: 'Ada Lovelace',
    email: 'ada@x.com',
    phone: '5551230000',
    headline: 'Analytical Engines Ltd',
    profile_url: null,
    source_channel: 'INDEED',
    arrived_at: '2026-07-01T00:00:00Z',
    refs: [{ ref_type: 'SOURCED_TALENT', ref_id: 'arr-1', link_source: 'INDEED' }],
    open_identity_advisories: [],
    ...over,
  };
}

function renderView(session: Session, ui?: ReactElement) {
  return render(
    <MemoryRouter>
      <ToastProvider>{ui ?? <SourcingPoolView sessionOverride={session} />}</ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // useSession() still runs; stub fetch so it settles quietly (sessionOverride wins).
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no session in test')));
});
afterEach(() => {
  cleanupMocks();
});
function cleanupMocks() {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
}

describe('SourcingPoolView — pool queue', () => {
  it('renders arrival rows with source + the pending-review indicator (no trust bands)', async () => {
    vi.mocked(getPool).mockResolvedValue(page([item({ open_advisory_count: 2 })], null));
    renderView(SOURCER);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('INDEED')).toBeInTheDocument();
    expect(screen.getByText('2 to review')).toBeInTheDocument();
    expect(screen.queryByText('Not established')).toBeNull();
    expect(screen.queryByText('Identity')).toBeNull();
  });

  it('empty pool shows the calm empty copy', async () => {
    vi.mocked(getPool).mockResolvedValue(page([], null));
    renderView(SOURCER);
    expect(await screen.findByText('No talent in the sourcing pool yet.')).toBeInTheDocument();
  });

  it('keyset "Load more" fetches the next page with the cursor', async () => {
    vi.mocked(getPool)
      .mockResolvedValueOnce(page([item({ subject_id: 's1', display_name: 'Ada', email: null })], 'cur-1'))
      .mockResolvedValueOnce(page([item({ subject_id: 's2', display_name: 'Grace', email: null })], null));
    renderView(SOURCER);
    await screen.findByText('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Grace')).toBeInTheDocument();
    expect(vi.mocked(getPool).mock.calls[1][0]).toEqual({ cursor: 'cur-1' });
  });
});

describe('SourcingPoolView — arrival drawer', () => {
  const oneRow = page([item()], null);

  it('Open drills into the drawer showing the arrival material (no trust ledger)', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    expect(await screen.findByText('Analytical Engines Ltd')).toBeInTheDocument();
    expect(screen.getByText('5551230000')).toBeInTheDocument();
    expect(screen.getByText('Sourced talent')).toBeInTheDocument();
    const drawer = screen.getByRole('dialog');
    expect(drawer.textContent ?? '').not.toMatch(/strength|Trust|Evidence/);
  });

  it('Save to pool → deferral renders as guidance, not an error toast', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    vi.mocked(saveToBench).mockResolvedValue({ status: 'deferred_unresolved_identity' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    await screen.findByText('Analytical Engines Ltd');
    fireEvent.click(screen.getByRole('button', { name: /Save to pool/ }));
    expect(
      await screen.findByText('Resolve the pending identity flag below before promoting this arrival.'),
    ).toBeInTheDocument();
  });

  it('Save to pool → incomplete contact renders its guidance', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    vi.mocked(saveToBench).mockResolvedValue({ status: 'deferred_incomplete_contact' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    await screen.findByText('Analytical Engines Ltd');
    fireEvent.click(screen.getByRole('button', { name: /Save to pool/ }));
    expect(
      await screen.findByText('This arrival needs both an email and a cell phone before it can be promoted.'),
    ).toBeInTheDocument();
  });

  it('Save to pool → promoted refreshes the pool', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    vi.mocked(saveToBench).mockResolvedValue({ status: 'promoted', talent_record_id: 'r1', bench_id: 'b1' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    await screen.findByText('Analytical Engines Ltd');
    expect(vi.mocked(getPool)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Save to pool/ }));
    await waitFor(() => expect(vi.mocked(saveToBench)).toHaveBeenCalledWith({ ref_type: 'SOURCED_TALENT', ref_id: 'arr-1' }));
    await waitFor(() => expect(vi.mocked(getPool)).toHaveBeenCalledTimes(2));
  });

  it('Add to pipeline picks a requisition and promotes with the SOURCED_TALENT ref_id', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    vi.mocked(listRequisitions).mockResolvedValue({
      items: [{ id: 'req-1', title: 'Senior Rust Engineer', status: 'open' }],
    } as never);
    vi.mocked(addToPipeline).mockResolvedValue({ status: 'promoted', talent_record_id: 'r1', pipeline_id: 'p1' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    await screen.findByText('Analytical Engines Ltd');
    fireEvent.click(screen.getByRole('button', { name: /Add to pipeline/ }));
    fireEvent.click(await screen.findByText('Senior Rust Engineer'));
    await waitFor(() =>
      expect(vi.mocked(addToPipeline)).toHaveBeenCalledWith({
        ref_type: 'SOURCED_TALENT',
        ref_id: 'arr-1',
        requisition_id: 'req-1',
      }),
    );
  });
});

describe('SourcingPoolView — advisory resolution (identity:resolve gating)', () => {
  const rowWithAdvisory = page([item({ open_advisory_count: 1 })], null);
  const withAdvisory = detail({
    open_identity_advisories: [
      {
        id: 'adv-1',
        talent_record_id: 'r9',
        talent_record_name: 'Ada King',
        basis: 'SOURCED_ARRIVAL',
        shared_kinds: ['EMAIL'],
        status: 'PENDING_REVIEW',
        created_at: '2026-07-02T00:00:00Z',
      },
    ],
  });

  it('a resolver can confirm the same person inline', async () => {
    vi.mocked(getPool).mockResolvedValue(rowWithAdvisory);
    vi.mocked(getSubjectDetail).mockResolvedValue(withAdvisory);
    vi.mocked(approveAdvisory).mockResolvedValue({
      id: 'adv-1',
      status: 'APPROVED',
      basis: 'SOURCED_ARRIVAL',
      surviving_record_id: 'r9',
    });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    expect(await screen.findByText('Ada King')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Same person' }));
    expect(await screen.findByTestId('advisory-kinds')).toHaveTextContent('Shares EMAIL');
    fireEvent.click(await screen.findByTestId('advisory-confirm'));
    await waitFor(() => expect(vi.mocked(approveAdvisory)).toHaveBeenCalledWith('adv-1', {}));
  });

  it('a non-resolver sees no link/dismiss actions (scope-gated)', async () => {
    vi.mocked(getPool).mockResolvedValue(rowWithAdvisory);
    vi.mocked(getSubjectDetail).mockResolvedValue(withAdvisory);
    renderView(SOURCER_NO_RESOLVE);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    expect(await screen.findByText('Possible match · shares EMAIL')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Same person' })).toBeNull();
    expect(
      screen.getByText('Resolving identity needs the identity:resolve permission.'),
    ).toBeInTheDocument();
  });
});
