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
// vi.mock above these imports) so the specs assert the FE behaviour (bands,
// keyset, promote mapping, advisory gating) without a server.
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

function detail(over: Partial<SubjectDetail> = {}): SubjectDetail {
  return {
    subject_id: 's1',
    display_name: 'Ada Lovelace',
    email: 'ada@x.com',
    trust_bands: {
      identity: 'SELF_ASSERTED',
      claims: null,
      continuity: null,
      eligibility: null,
    },
    open_contradiction_count: 0,
    evidence: [
      {
        id: 'e1',
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: 'Ada' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        current_status: 'VALID',
        collected_at: '2026-07-01T00:00:00Z',
        created_at: '2026-07-01T00:00:00Z',
      },
    ],
    refs: [{ ref_type: 'SOURCED_TALENT', ref_id: 'arr-1', link_source: 'x' }],
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
  it('renders rows with trust band labels + the contradiction indicator', async () => {
    vi.mocked(getPool).mockResolvedValue(
      page(
        [
          {
            subject_id: 's1',
            display_name: 'Ada Lovelace',
            email: 'ada@x.com',
            trust_bands: { identity: 'SELF_ASSERTED', claims: null, continuity: null, eligibility: null },
            open_contradiction_count: 2,
          },
        ],
        null,
      ),
    );
    renderView(SOURCER);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // Band label (R10 — a label, not a number).
    expect(screen.getByText('Self-asserted')).toBeInTheDocument();
    // A null band renders "Not established".
    expect(screen.getAllByText('Not established').length).toBeGreaterThan(0);
    expect(screen.getByText('2 to review')).toBeInTheDocument();
  });

  it('empty pool shows the calm empty copy', async () => {
    vi.mocked(getPool).mockResolvedValue(page([], null));
    renderView(SOURCER);
    expect(await screen.findByText('No talent in the sourcing pool yet.')).toBeInTheDocument();
  });

  it('keyset "Load more" fetches the next page with the cursor', async () => {
    vi.mocked(getPool)
      .mockResolvedValueOnce(
        page(
          [
            {
              subject_id: 's1',
              display_name: 'Ada',
              email: null,
              trust_bands: { identity: null, claims: null, continuity: null, eligibility: null },
              open_contradiction_count: 0,
            },
          ],
          'cur-1',
        ),
      )
      .mockResolvedValueOnce(
        page(
          [
            {
              subject_id: 's2',
              display_name: 'Grace',
              email: null,
              trust_bands: { identity: null, claims: null, continuity: null, eligibility: null },
              open_contradiction_count: 0,
            },
          ],
          null,
        ),
      );
    renderView(SOURCER);
    await screen.findByText('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Grace')).toBeInTheDocument();
    expect(vi.mocked(getPool).mock.calls[1][0]).toEqual({ cursor: 'cur-1' });
  });
});

describe('SourcingPoolView — subject drawer', () => {
  const oneRow = page(
    [
      {
        subject_id: 's1',
        display_name: 'Ada Lovelace',
        email: 'ada@x.com',
        trust_bands: { identity: 'SELF_ASSERTED', claims: null, continuity: null, eligibility: null },
        open_contradiction_count: 0,
      },
    ],
    null,
  );

  it('Open drills into the drawer showing evidence WITHOUT strength (R10)', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    // Evidence row: assertion type + source/method/date, never a strength number.
    expect(await screen.findByText('FULL_NAME')).toBeInTheDocument();
    expect(screen.getByText(/THIRD_PARTY_UNVERIFIED · DOCUMENT/)).toBeInTheDocument();
    // No numeric strength leaked anywhere in the drawer.
    const drawer = screen.getByRole('dialog');
    expect(drawer.textContent ?? '').not.toMatch(/strength/i);
  });

  it('Save to pool → deferral renders as guidance, not an error toast', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    vi.mocked(saveToBench).mockResolvedValue({ status: 'deferred_unresolved_identity' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    await screen.findByText('FULL_NAME');
    fireEvent.click(screen.getByRole('button', { name: /Save to pool/ }));
    expect(
      await screen.findByText('Resolve the pending identity flag below before promoting this subject.'),
    ).toBeInTheDocument();
  });

  it('Save to pool → promoted refreshes the pool', async () => {
    vi.mocked(getPool).mockResolvedValue(oneRow);
    vi.mocked(getSubjectDetail).mockResolvedValue(detail());
    vi.mocked(saveToBench).mockResolvedValue({ status: 'promoted', talent_record_id: 'r1', bench_id: 'b1' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    await screen.findByText('FULL_NAME');
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
    await screen.findByText('FULL_NAME');
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
  const rowWithAdvisory = page(
    [
      {
        subject_id: 's1',
        display_name: 'Ada Lovelace',
        email: 'ada@x.com',
        trust_bands: { identity: 'SELF_ASSERTED', claims: null, continuity: null, eligibility: null },
        open_contradiction_count: 0,
      },
    ],
    null,
  );
  const withAdvisory = detail({
    open_identity_advisories: [
      {
        id: 'adv-1',
        subject_a_id: 's1',
        subject_b_id: 's9',
        advise_band: 'STRONG',
        has_contradiction: false,
        status: 'PENDING_REVIEW',
        created_at: '2026-07-02T00:00:00Z',
      },
    ],
  });

  it('a resolver can approve an advisory inline', async () => {
    vi.mocked(getPool).mockResolvedValue(rowWithAdvisory);
    vi.mocked(getSubjectDetail).mockResolvedValue(withAdvisory);
    vi.mocked(approveAdvisory).mockResolvedValue({ id: 'adv-1', status: 'MERGED', has_contradiction: false, resolution_action: 'MERGE' });
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve merge' }));
    // Non-contradicted → no override ack required; confirm immediately.
    fireEvent.click(await screen.findByTestId('advisory-confirm'));
    await waitFor(() => expect(vi.mocked(approveAdvisory)).toHaveBeenCalledWith('adv-1', {}));
  });

  it('a non-resolver sees no approve/dismiss actions (scope-gated)', async () => {
    vi.mocked(getPool).mockResolvedValue(rowWithAdvisory);
    vi.mocked(getSubjectDetail).mockResolvedValue(withAdvisory);
    renderView(SOURCER_NO_RESOLVE);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    // The advisory renders, but the actions are gated away.
    expect(await screen.findByText('Possible match')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve merge' })).toBeNull();
    expect(
      screen.getByText('Resolving identity needs the identity:resolve permission.'),
    ).toBeInTheDocument();
  });

  it('a contradicted advisory approve requires the ack + justification (R3)', async () => {
    vi.mocked(getPool).mockResolvedValue(rowWithAdvisory);
    vi.mocked(getSubjectDetail).mockResolvedValue(
      detail({
        open_identity_advisories: [
          {
            id: 'adv-2',
            subject_a_id: 's1',
            subject_b_id: 's9',
            advise_band: 'STRONG',
            has_contradiction: true,
            status: 'PENDING_REVIEW',
            created_at: '2026-07-02T00:00:00Z',
          },
        ],
      }),
    );
    renderView(SOURCER);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ada Lovelace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve merge' }));
    // Confirm is disabled until ack + justification are supplied (R3).
    const confirm = await screen.findByTestId('advisory-confirm');
    expect(confirm).toBeDisabled();
  });
});
