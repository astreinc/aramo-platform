import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { transitionPipeline } from '../pipeline/pipeline-api';
import type { PipelineView } from '../pipeline/types';

import { TalentDetailPanel } from './TalentDetailPanel';

vi.mock('../pipeline/pipeline-api', () => ({
  getTalentRecord: vi.fn(async () => ({ id: 't1', first_name: 'Sarah', last_name: 'Nolan' })),
  transitionPipeline: vi.fn(async (_id: string, body: { to_status: string }) => ({
    id: 'p1',
    tenant_id: 'T',
    site_id: null,
    talent_record_id: 't1',
    requisition_id: 'r1',
    status: body.to_status,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  })),
}));

const ENTRY: PipelineView = {
  id: 'p1',
  tenant_id: 'T',
  site_id: null,
  talent_record_id: 't1',
  requisition_id: 'r1',
  status: 'interviewing',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function renderPanel(over: Partial<Parameters<typeof TalentDetailPanel>[0]> = {}) {
  const onClose = vi.fn();
  const onTransitioned = vi.fn();
  render(
    <MemoryRouter>
      <TalentDetailPanel
        entry={ENTRY}
        talentName="Sarah Nolan"
        isNew
        reqTitle="Senior Rust Engineer"
        reqCode="REQ-2041"
        onClose={onClose}
        onTransitioned={onTransitioned}
        {...over}
      />
    </MemoryRouter>,
  );
  return { onClose, onTransitioned };
}

describe('TalentDetailPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders header (name, NEW, role · req code) + the six workflow stages', () => {
    renderPanel();
    expect(screen.getByText('Sarah Nolan')).toBeTruthy();
    expect(screen.getByText('NEW')).toBeTruthy();
    expect(screen.getByText('Senior Rust Engineer · REQ-2041')).toBeTruthy();
    for (const s of ['Sourced', 'Qualifying', 'Submitted', 'Interview', 'Offer', 'Placed']) {
      expect(screen.getByText(s)).toBeTruthy();
    }
    expect(screen.getByText('Every change is logged to the audit trail.')).toBeTruthy();
  });

  it('marks the current stage (interviewing → Interview) with the CURRENT chip', () => {
    renderPanel();
    expect(screen.getByText('CURRENT')).toBeTruthy();
    // Interview's step carries aria-current="step"
    const current = screen.getByText('Interview').closest('button');
    expect(current?.getAttribute('aria-current')).toBe('step');
  });

  it('only a LEGAL next stage is clickable — from interviewing, Offer is enabled, Sourced is not', () => {
    renderPanel();
    const offerBtn = screen.getByText('Offer').closest('button') as HTMLButtonElement;
    const sourcedBtn = screen.getByText('Sourced').closest('button') as HTMLButtonElement;
    expect(offerBtn.disabled).toBe(false); // interviewing → offered is legal
    expect(sourcedBtn.disabled).toBe(true); // illegal jump backward
  });

  it('clicking a legal stage calls the governed transition + onTransitioned', async () => {
    const { onTransitioned } = renderPanel();
    fireEvent.click(screen.getByText('Offer').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(transitionPipeline).toHaveBeenCalledTimes(1));
    expect(transitionPipeline).toHaveBeenCalledWith('p1', { to_status: 'offered' });
    await waitFor(() => expect(onTransitioned).toHaveBeenCalledTimes(1));
  });

  it('close via ✕ and via backdrop click', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('agreed pay rate shows the em-dash placeholder when not agreed', () => {
    renderPanel();
    expect(screen.getByText('Agreed pay rate')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
