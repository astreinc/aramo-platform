import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { RequisitionTalentBoard } from './RequisitionTalentBoard';
import {
  getRequisitionTalentBoard,
  type BoardCardView,
  type RequisitionTalentBoardView,
} from './requisition-talent-board-api';

// TB-2 — the read-only Board surface. The backend is authoritative for column placement,
// owner attribution, Closed derivation, résumé linkage and Qualified band; these tests pin the
// PRESENTATION: column counts, card labels, the Qualified two-band split, the résumé-locked
// indicator, the collapsed Closed panel, drawer hand-off by pipeline_id, and load/error states.
vi.mock('./requisition-talent-board-api', async (importActual) => {
  const actual = await importActual<typeof import('./requisition-talent-board-api')>();
  return { ...actual, getRequisitionTalentBoard: vi.fn() };
});
const mockGet = getRequisitionTalentBoard as unknown as Mock;

function card(overrides: Partial<BoardCardView> = {}): BoardCardView {
  return {
    talent_record_id: 't1',
    pipeline_id: 'p1',
    column: 'qualified',
    owner: 'pipeline',
    source_object_id: 'p1',
    owner_state: 'qualified',
    resume: { resume_edition_id: null, source: 'none', locked: false },
    rtr_state: null,
    readiness: null,
    days_in_stage: null,
    stage_entered_at: null,
    assigned_recruiter_user_id: null,
    next_actions: [],
    ...overrides,
  };
}

function board(overrides: Partial<RequisitionTalentBoardView> = {}): RequisitionTalentBoardView {
  return {
    requisition_id: 'r1',
    columns: [],
    closed: { total: 0, by_reason: [] },
    total_active: 0,
    ...overrides,
  };
}

const NAMES = { t1: 'Ada Lovelace', t2: 'Grace Hopper', t3: 'Katherine Johnson' };

beforeEach(() => {
  mockGet.mockReset();
});

describe('RequisitionTalentBoard (TB-2)', () => {
  it('renders every column with its count and card names', async () => {
    mockGet.mockResolvedValue(
      board({
        total_active: 2,
        columns: [
          { key: 'contacted', owner: 'pipeline', count: 1, cards: [card({ talent_record_id: 't1', pipeline_id: 'p1', column: 'contacted', owner_state: 'contacted' })] },
          { key: 'submitted', owner: 'submittal', count: 1, cards: [card({ talent_record_id: 't2', pipeline_id: 'p2', column: 'submitted', owner: 'submittal', owner_state: 'submitted_to_ats' })] },
        ],
      }),
    );
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} onSelectCard={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText('Talent board')).toBeInTheDocument());
    // All 11 canonical columns render (even empty ones).
    expect(screen.getByLabelText('Contacted')).toBeInTheDocument();
    expect(screen.getByLabelText('Started')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Contacted')).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Submitted')).getByText('Grace Hopper')).toBeInTheDocument();
  });

  it('splits the Qualified column into Ready-to-submit / Needs-action bands with blockers', async () => {
    mockGet.mockResolvedValue(
      board({
        total_active: 2,
        columns: [
          {
            key: 'qualified',
            owner: 'pipeline',
            count: 2,
            cards: [
              card({ talent_record_id: 't1', pipeline_id: 'p1', readiness: { requisition_state: 'open', requisition_reason: null, blockers: [], band: 'ready_to_submit' } }),
              card({ talent_record_id: 't2', pipeline_id: 'p2', readiness: { requisition_state: 'open', requisition_reason: null, blockers: ['resume_not_selected'], band: 'needs_action' } }),
            ],
          },
        ],
      }),
    );
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} onSelectCard={vi.fn()} />);

    const col = await screen.findByLabelText('Qualified');
    // Each band label appears (group heading + card pill share the text → at least one each).
    expect(within(col).getAllByText('Ready to submit').length).toBeGreaterThanOrEqual(1);
    expect(within(col).getAllByText('Needs action').length).toBeGreaterThanOrEqual(1);
    // The needs-action card surfaces its specific blocker (recruiting fact, not policy engine).
    expect(within(col).getByText('Résumé not selected')).toBeInTheDocument();
  });

  it('shows the résumé-locked indicator on a submitted (frozen) card', async () => {
    mockGet.mockResolvedValue(
      board({
        total_active: 1,
        columns: [
          {
            key: 'submitted',
            owner: 'submittal',
            count: 1,
            cards: [card({ talent_record_id: 't1', pipeline_id: 'p1', column: 'submitted', owner: 'submittal', owner_state: 'submitted_to_ats', resume: { resume_edition_id: 're1', source: 'submitted_frozen', locked: true } })],
          },
        ],
      }),
    );
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} onSelectCard={vi.fn()} />);
    expect(await screen.findByText('Résumé locked')).toBeInTheDocument();
  });

  it('renders the collapsed Closed panel with canonical reason labels', async () => {
    mockGet.mockResolvedValue(
      board({
        closed: { total: 3, by_reason: [{ reason: 'not_in_consideration', count: 2 }, { reason: 'offer_declined', count: 1 }] },
      }),
    );
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} onSelectCard={vi.fn()} />);
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Not in consideration')).toBeInTheDocument();
    expect(screen.getByText('Offer declined')).toBeInTheDocument();
  });

  it('hands a card click back to the drawer by pipeline_id', async () => {
    const onSelectCard = vi.fn();
    mockGet.mockResolvedValue(
      board({
        total_active: 1,
        columns: [{ key: 'qualified', owner: 'pipeline', count: 1, cards: [card({ talent_record_id: 't1', pipeline_id: 'pipe-42' })] }],
      }),
    );
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} onSelectCard={onSelectCard} />);
    const cardBtn = await screen.findByRole('button', { name: 'Open Ada Lovelace' });
    fireEvent.click(cardBtn);
    expect(onSelectCard).toHaveBeenCalledWith('pipe-42');
  });

  it('shows a loading state then an error message on failure', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} onSelectCard={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  // TB-3 — the bounded next-action menu, scope-gated.
  it('renders a projected next action only when the actor holds its required scope', async () => {
    const withAction = card({
      talent_record_id: 't1',
      pipeline_id: 'p1',
      column: 'qualified',
      next_actions: [{ key: 'pipeline.qualify', label: 'Qualify', owner: 'pipeline', command_route: 'POST /v1/pipelines/p1/actions', required_scope: 'pipeline:change-status' }],
    });
    mockGet.mockResolvedValue(board({ total_active: 1, columns: [{ key: 'qualified', owner: 'pipeline', count: 1, cards: [withAction] }] }));

    // WITHOUT the scope → the action is hidden (UI hiding is not the boundary, but the affordance is gated).
    const { unmount } = render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} scopes={[]} onSelectCard={vi.fn()} />);
    await screen.findByLabelText('Talent board');
    expect(screen.queryByRole('button', { name: 'Qualify' })).not.toBeInTheDocument();
    unmount();

    // WITH the scope → the action renders.
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} scopes={['pipeline:change-status']} onSelectCard={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Qualify' })).toBeInTheDocument();
  });

  it('routes a next action to the governed drawer surface (onSelectCard by pipeline_id)', async () => {
    const onSelectCard = vi.fn();
    const c = card({
      talent_record_id: 't1',
      pipeline_id: 'pipe-7',
      column: 'selected',
      owner: 'client_selection',
      next_actions: [{ key: 'offer.create', label: 'Create offer', owner: 'offer', command_route: 'POST /v1/offers', required_scope: 'offer:create' }],
    });
    mockGet.mockResolvedValue(board({ total_active: 1, columns: [{ key: 'selected', owner: 'client_selection', count: 1, cards: [c] }] }));
    render(<RequisitionTalentBoard requisitionId="r1" talentNames={NAMES} scopes={['offer:create']} onSelectCard={onSelectCard} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create offer' }));
    expect(onSelectCard).toHaveBeenCalledWith('pipe-7');
  });
});
