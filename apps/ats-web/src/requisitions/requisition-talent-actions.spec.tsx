import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipelineView } from '../pipeline/types';
import { SignSubscriptionProvider } from '../rtr/rtr-access';

import { useRequisitionTalentActions } from './requisition-talent-actions';
import type { RequisitionView } from './types';

// ATS-QA-1 D5 — Not in consideration changes an episode IN PLACE; the page must reload
// its pipelines so the Talent tab label and the "in play" count reflect it.
const h = vi.hoisted(() => ({
  dispositionPipelineEpisode: vi.fn(),
  voidPipelineEpisode: vi.fn(),
  getRequisitionTalentBoard: vi.fn(),
}));
vi.mock('../pipeline/pipeline-api', () => ({
  dispositionPipelineEpisode: h.dispositionPipelineEpisode,
  voidPipelineEpisode: h.voidPipelineEpisode,
}));
vi.mock('./requisition-talent-board-api', () => ({ getRequisitionTalentBoard: h.getRequisitionTalentBoard }));

const REQ = { id: 'r1', title: 'BA', requisition_number: 7, company_id: 'c1' } as unknown as RequisitionView;
const PIPE = { id: 'p1', talent_record_id: 't1', requisition_id: 'r1', status: 'qualifying', version: 3 } as unknown as PipelineView;

function Harness({ onPipelinesChanged }: { onPipelinesChanged?: () => void }) {
  const a = useRequisitionTalentActions({
    req: REQ,
    pipelines: [PIPE],
    talents: {},
    placements: [],
    scopes: [],
    canReadPlacements: false,
    onPipelineRemoved: () => undefined,
    onPipelinesChanged,
  });
  return (
    <>
      <button type="button" onClick={() => a.requestNotInConsideration('p1', 'Ada Lovelace')}>
        open nic
      </button>
      {a.portals}
    </>
  );
}

function mount(onPipelinesChanged?: () => void) {
  render(
    <SignSubscriptionProvider subscribed={false}>
      <MemoryRouter>
        <Harness onPipelinesChanged={onPipelinesChanged} />
      </MemoryRouter>
    </SignSubscriptionProvider>,
  );
}

beforeEach(() => {
  h.dispositionPipelineEpisode.mockReset();
  h.getRequisitionTalentBoard.mockReset();
  h.getRequisitionTalentBoard.mockResolvedValue({ columns: [] });
});

describe('useRequisitionTalentActions — Not in consideration (ATS-QA-1 D5)', () => {
  it('reloads the page pipelines after the disposition is recorded', async () => {
    h.dispositionPipelineEpisode.mockResolvedValue({});
    const changed = vi.fn();
    mount(changed);
    fireEvent.click(screen.getByRole('button', { name: 'open nic' }));
    fireEvent.click((await screen.findAllByRole('radio'))[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Not in consideration' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(h.dispositionPipelineEpisode).toHaveBeenCalledWith('p1', expect.objectContaining({ expected_version: 3 }));
  });

  it('does not reload when the server refuses the disposition', async () => {
    h.dispositionPipelineEpisode.mockRejectedValue(new Error('refused'));
    const changed = vi.fn();
    mount(changed);
    fireEvent.click(screen.getByRole('button', { name: 'open nic' }));
    fireEvent.click((await screen.findAllByRole('radio'))[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Not in consideration' }));
    await waitFor(() => expect(h.dispositionPipelineEpisode).toHaveBeenCalled());
    expect(changed).not.toHaveBeenCalled();
  });
});
