import { describe, expect, it } from 'vitest';

import { formatActivityNote } from '../activity/activity-note-format';
import { STEPS } from '../requisitions/talent-requisition-360/tr360-model';
import { STAGES, stagePill } from '../talent-360/t360-model';
import { stageLabel } from '../ui/stage-map';

import { JOURNEY_STAGE_LABELS, journeyStageLabel } from './journey-vocab';
import { PIPELINE_STATUS_LABELS, pipelineStatusLabel } from './types';

// ATS-QA-1 I-2 (amendment rows A5/A6) — the canonical `no_contact` milestone is DISPLAYED
// "Not contacted". The stored value, commands, events and history are unchanged: only the
// front-end label maps move, and historical transition notes are re-labelled at display time.
describe('"Not contacted" display label for the canonical no_contact milestone', () => {
  it('every pipeline/journey label map shows "Not contacted" (stored code unchanged)', () => {
    expect(PIPELINE_STATUS_LABELS.no_contact).toBe('Not contacted');
    expect(pipelineStatusLabel('no_contact')).toBe('Not contacted');
    expect(stageLabel('no_contact')).toBe('Not contacted');
    expect(JOURNEY_STAGE_LABELS['SOURCED']).toBe('Not contacted');
    expect(journeyStageLabel('SOURCED')).toBe('Not contacted');
    expect(STEPS.find((s) => s.key === 'no_contact')?.label).toBe('Not contacted');
    expect(STAGES[0]).toBe('Not contacted');
    expect(stagePill('SOURCED')).toEqual({ label: 'Not contacted', tone: 'grey' });
  });

  it('no label map still carries the old "No contact" wording', () => {
    const all: readonly string[] = [
      ...Object.values(PIPELINE_STATUS_LABELS),
      ...Object.values(JOURNEY_STAGE_LABELS),
      ...STEPS.map((s) => s.label),
      ...STAGES,
    ];
    expect(all).not.toContain('No contact');
  });

  it('historical activity rows (stored as `pipeline no_contact -> …`) render "Not contacted"', () => {
    expect(formatActivityNote('pipeline no_contact -> contacted')).toBe('Not contacted → Contacted');
    expect(formatActivityNote('pipeline no_contact -> not_in_consideration: wrong location')).toBe(
      'Not contacted → Not in consideration — wrong location',
    );
  });
});
