import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TalentJourneyPanel } from './TalentJourneyPanel';
import type { TalentRequisitionJourney } from './talent-journey-api';

// Lane 2 / L2-H — AC-8: the FE renders the BE-composed stage as the SINGLE source; the
// offer/decline/placement derivation is NOT independently re-authored on the journey
// surface (negative control: the panel does not import derivePipelineDisplayFromPlacement).

const JOURNEY: TalentRequisitionJourney = {
  requisition_id: 'r1',
  talent_record_id: 't1',
  // The server computed STARTED from PlacementProcess while the Pipeline rests at its
  // most-advanced canonical stage (`qualified`) — the FE must render exactly this, never re-derive it.
  current_journey_stage: 'STARTED',
  stages: [
    { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
    { stage: 'SUBMITTED', owner: 'submittal', source_object_id: 'sub1' },
    { stage: 'STARTED', owner: 'placement', source_object_id: 'pl1' },
  ],
  sub_states: { pipeline_stage: 'qualified', placement_state: 'STARTED', offer_state: 'ACCEPTED' },
  actions: [{ action: 'Complete Requirement', owner: 'pre-start', command_route: 'POST /v1/...' }],
};

vi.mock('./talent-journey-api', () => ({
  getTalentJourney: vi.fn(async () => JOURNEY),
}));

describe('TalentJourneyPanel — AC-8 single-source', () => {
  it('renders the BE-composed current_journey_stage verbatim (no local re-derivation)', async () => {
    render(<TalentJourneyPanel pipelineId="p1" />);
    await waitFor(() => expect(screen.getByTestId('journey-current-stage')).toHaveTextContent('STARTED'));
    // The owner-attributed stage + owner label come straight from the composed response.
    expect(screen.getByText('placement')).toBeInTheDocument();
  });

  it('NEGATIVE CONTROL — the journey panel does NOT import the placement-board stage derivation', () => {
    const src = readFileSync(resolve(__dirname, 'TalentJourneyPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/derivePipelineDisplayFromPlacement/);
    expect(src).not.toMatch(/board-derivation/);
  });
});
