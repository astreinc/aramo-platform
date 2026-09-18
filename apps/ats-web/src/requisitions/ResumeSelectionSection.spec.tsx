import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ResumeSelectionSection } from './ResumeSelectionSection';
import {
  getPipelineResumeEdition,
  setPipelineResumeEdition,
} from '../pipeline/pipeline-api';
import type { PipelineResumeEditionView } from '../pipeline/types';

vi.mock('../pipeline/pipeline-api', () => ({
  getPipelineResumeEdition: vi.fn(),
  setPipelineResumeEdition: vi.fn(),
}));

const PIPE_ID = '00000000-0000-7000-8000-71be00000001';
const ED_A = '00000000-0000-7000-8000-71be000000e1';
const ED_B = '00000000-0000-7000-8000-71be000000e2';

// TI-1D-D — two active editions; ED_A is the Talent-global default (a SUGGESTION),
// no explicit working selection yet.
const NO_SELECTION: PipelineResumeEditionView = {
  pipeline_id: PIPE_ID,
  talent_record_id: '00000000-0000-7000-8000-7a1e00000001',
  requisition_id: '00000000-0000-7000-8000-4e9100000001',
  selected_edition_id: null,
  selected_at: null,
  selected_by: null,
  default_edition_id: ED_A,
  available_editions: [
    {
      edition_id: ED_A,
      purpose: 'GENERAL',
      label: null,
      filename: 'grace-general.pdf',
      mime_type: 'application/pdf',
      created_at: '2026-07-01T00:00:00Z',
      is_default: true,
    },
    {
      edition_id: ED_B,
      purpose: 'CLIENT_SUBMITTAL',
      label: 'Tailored',
      filename: 'grace-tailored.pdf',
      mime_type: 'application/pdf',
      created_at: '2026-07-05T00:00:00Z',
      is_default: false,
    },
  ],
};

const WITH_SELECTION: PipelineResumeEditionView = {
  ...NO_SELECTION,
  selected_edition_id: ED_B,
  selected_at: '2026-07-06T00:00:00Z',
  selected_by: '00000000-0000-7000-8000-71be000000a1',
};

describe('ResumeSelectionSection', () => {
  beforeEach(() => {
    vi.mocked(getPipelineResumeEdition).mockReset();
    vi.mocked(setPipelineResumeEdition).mockReset();
    vi.mocked(getPipelineResumeEdition).mockResolvedValue(NO_SELECTION);
    vi.mocked(setPipelineResumeEdition).mockResolvedValue(WITH_SELECTION);
  });

  it('reads the résumé state from GET /v1/pipelines/:id/resume-edition on mount', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    await waitFor(() => expect(getPipelineResumeEdition).toHaveBeenCalledWith(PIPE_ID));
    // Both editions are listed as their own rows (the default filename also
    // appears in the suggestion note, so scope the assertion to the rows).
    expect(await screen.findByTestId(`resume-row-${ED_A}`)).toHaveTextContent(
      'grace-general.pdf',
    );
    expect(screen.getByTestId(`resume-row-${ED_B}`)).toHaveTextContent(
      'grace-tailored.pdf',
    );
  });

  it('surfaces the default as a SUGGESTION when there is no explicit selection', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    // The default edition is marked as suggested, NOT as the bound selection.
    expect(await screen.findByTestId('resume-default-suggestion')).toBeInTheDocument();
    expect(screen.queryByTestId('resume-current-selection')).not.toBeInTheDocument();
  });

  it('an explicit "Use this résumé" click PUTs the selection and refetches', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    const useBtn = await screen.findByTestId(`resume-use-${ED_B}`);
    fireEvent.click(useBtn);
    await waitFor(() =>
      expect(setPipelineResumeEdition).toHaveBeenCalledWith(PIPE_ID, {
        resume_edition_id: ED_B,
      }),
    );
    // After the write the section re-reads the authoritative state.
    await waitFor(() => expect(getPipelineResumeEdition).toHaveBeenCalledTimes(2));
  });

  it('PREVIEW never binds — opening a preview does NOT call the PUT', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    const preview = await screen.findByTestId(`resume-preview-${ED_A}`);
    fireEvent.click(preview);
    expect(setPipelineResumeEdition).not.toHaveBeenCalled();
  });

  it('without pipeline:resume:set there is NO "Use this résumé" affordance', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection={false} />);
    await screen.findByTestId(`resume-row-${ED_A}`);
    expect(screen.queryByTestId(`resume-use-${ED_A}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`resume-use-${ED_B}`)).not.toBeInTheDocument();
    // Preview stays available regardless of the mutation scope.
    expect(screen.getByTestId(`resume-preview-${ED_A}`)).toBeInTheDocument();
  });

  it('shows the current bound selection when one exists', async () => {
    vi.mocked(getPipelineResumeEdition).mockResolvedValue(WITH_SELECTION);
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    const current = await screen.findByTestId('resume-current-selection');
    expect(current).toHaveTextContent('grace-tailored.pdf');
  });
});
