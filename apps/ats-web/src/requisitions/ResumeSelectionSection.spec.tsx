import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPipelineResumeEdition,
  setPipelineResumeEdition,
} from '../pipeline/pipeline-api';
import type { PipelineResumeEditionView } from '../pipeline/types';
import {
  createAttachment,
  createTalentResumeEdition,
  getTalentResumeEditionText,
  putResumeToStorage,
  requestResumeUploadUrl,
} from '../talent/talent-api';

import { ResumeSelectionSection } from './ResumeSelectionSection';

vi.mock('../pipeline/pipeline-api', () => ({
  getPipelineResumeEdition: vi.fn(),
  setPipelineResumeEdition: vi.fn(),
}));
vi.mock('../talent/talent-api', () => ({
  createAttachment: vi.fn(),
  createTalentResumeEdition: vi.fn(),
  getTalentResumeEditionText: vi.fn(),
  putResumeToStorage: vi.fn(),
  requestResumeUploadUrl: vi.fn(),
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
  selected_lifecycle_status: null,
  selected_requires_attention: false,
  available_editions: [
    {
      edition_id: ED_A,
      purpose: 'GENERAL',
      label: null,
      requisition_id: null,
      revision_number: 1,
      filename: 'grace-general.pdf',
      mime_type: 'application/pdf',
      created_at: '2026-07-01T00:00:00Z',
      is_default: true,
    },
    {
      edition_id: ED_B,
      purpose: 'CLIENT_SUBMITTAL',
      label: 'Tailored',
      requisition_id: '00000000-0000-7000-8000-4e9100000001',
      revision_number: 2,
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
  selected_lifecycle_status: 'active',
  selected_requires_attention: false,
};

// Resume Revision Lifecycle §9 — a selection that was archived AFTER it was chosen:
// the archived edition is no longer among the active available_editions, and the
// backend flags selected_requires_attention. The system never silently switches.
const ARCHIVED_SELECTION: PipelineResumeEditionView = {
  ...NO_SELECTION,
  selected_edition_id: ED_B,
  selected_at: '2026-07-06T00:00:00Z',
  selected_by: '00000000-0000-7000-8000-71be000000a1',
  selected_lifecycle_status: 'archived',
  selected_requires_attention: true,
  // ED_B (archived) dropped from the active picker; only ED_A remains selectable.
  available_editions: NO_SELECTION.available_editions.filter((e) => e.edition_id === ED_A),
};

describe('ResumeSelectionSection', () => {
  beforeEach(() => {
    vi.mocked(getPipelineResumeEdition).mockReset();
    vi.mocked(setPipelineResumeEdition).mockReset();
    vi.mocked(getTalentResumeEditionText).mockResolvedValue({
      talent_id: NO_SELECTION.talent_record_id,
      edition_id: ED_A,
      status: 'EXTRACTED',
      redacted_text: 'resume text',
      extracted_at: null,
    });
    vi.mocked(getPipelineResumeEdition).mockResolvedValue(NO_SELECTION);
    vi.mocked(setPipelineResumeEdition).mockResolvedValue(WITH_SELECTION);
  });

  it('reads the resume state from GET /v1/pipelines/:id/resume-edition on mount', async () => {
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

  // §9 — an archived selection surfaces "requires attention" (never silently
  // switched); the archived edition is not offered in the active picker.
  it('§9 — shows requires-attention when the current selection has been archived', async () => {
    vi.mocked(getPipelineResumeEdition).mockResolvedValue(ARCHIVED_SELECTION);
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    expect(await screen.findByTestId('resume-requires-attention')).toBeInTheDocument();
    // The archived edition is absent from the selectable rows; the active one remains.
    expect(screen.queryByTestId(`resume-row-${ED_B}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`resume-row-${ED_A}`)).toBeInTheDocument();
  });

  it('an explicit "Use this resume" click PUTs the selection and refetches', async () => {
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

  it('without pipeline:resume:set there is NO "Use this resume" affordance', async () => {
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

  it('Preview opens the edition\'s own redacted text in a popup and closes on the X', async () => {
    vi.mocked(getTalentResumeEditionText).mockResolvedValue({
      talent_id: NO_SELECTION.talent_record_id,
      edition_id: ED_B,
      status: 'EXTRACTED',
      redacted_text: 'Grace Hopper — tailored for BA',
      extracted_at: '2026-07-05T00:00:00Z',
    });
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    fireEvent.click(await screen.findByTestId(`resume-preview-${ED_B}`));
    expect(await screen.findByTestId('resume-preview-text')).toHaveTextContent('Grace Hopper — tailored for BA');
    expect(getTalentResumeEditionText).toHaveBeenCalledWith(NO_SELECTION.talent_record_id, ED_B);
    fireEvent.click(screen.getByRole('button', { name: 'Close resume preview' }));
    await waitFor(() => expect(screen.queryByTestId('resume-preview-text')).not.toBeInTheDocument());
    expect(setPipelineResumeEdition).not.toHaveBeenCalled();
  });

  it('labels the tailored revision and uses standard status pills', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    const row = await screen.findByTestId(`resume-row-${ED_B}`);
    expect(row).toHaveTextContent('Tailored for this requisition');
    expect(row.querySelector('.rc-pill')).not.toBeNull();
  });

  it('"Upload tailored resume" adds a REQUISITION revision derived from the default — and does NOT select it', async () => {
    vi.mocked(requestResumeUploadUrl).mockResolvedValue({ presigned_url: 'https://s3/put', storage_key: 'k1' } as never);
    vi.mocked(putResumeToStorage).mockResolvedValue(undefined);
    vi.mocked(createAttachment).mockResolvedValue({ id: 'att-1' } as never);
    vi.mocked(createTalentResumeEdition).mockResolvedValue({ edition_id: 'ed-new' } as never);
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection canUploadTailored />);
    const input = await screen.findByTestId('resume-tailored-input');
    const file = new File(['x'], 'grace-ba.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(createTalentResumeEdition).toHaveBeenCalledWith(NO_SELECTION.talent_record_id, {
        attachment_id: 'att-1',
        purpose: 'REQUISITION',
        requisition_id: NO_SELECTION.requisition_id,
        derived_from_edition_id: ED_A,
      }),
    );
    expect(createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ owner_type: 'talent', owner_id: NO_SELECTION.talent_record_id, is_resume: true }),
    );
    expect(await screen.findByTestId('resume-upload-notice')).toBeInTheDocument();
    expect(setPipelineResumeEdition).not.toHaveBeenCalled();
  });

  it('hides "Upload tailored resume" without talent:edit + attachment:create', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    await screen.findByTestId(`resume-row-${ED_A}`);
    expect(screen.queryByTestId('resume-upload-tailored')).not.toBeInTheDocument();
  });
});

// ATS-QA-1 D14 — the copy names the control that is actually on screen ("Use this
// resume"), and never points at a control the viewer does not have.
describe('ResumeSelectionSection — copy matches the control (ATS-QA-1 D14)', () => {
  beforeEach(() => {
    vi.mocked(getPipelineResumeEdition).mockReset();
    vi.mocked(getPipelineResumeEdition).mockResolvedValue(NO_SELECTION);
  });

  it('with pipeline:resume:set the suggestion names the “Use this resume” button that is shown', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    const note = await screen.findByTestId('resume-default-suggestion');
    expect(note).toHaveTextContent('choose “Use this resume” below to use it for this requisition');
    expect(note).not.toHaveTextContent(/select one below/);
    expect(screen.getAllByRole('button', { name: 'Use this resume' }).length).toBeGreaterThan(0);
  });

  it('without pipeline:resume:set the suggestion names no control', async () => {
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection={false} />);
    const note = await screen.findByTestId('resume-default-suggestion');
    expect(note).toHaveTextContent('No resume selected yet. Suggested default: grace-general.pdf.');
    expect(note).not.toHaveTextContent(/below/);
    expect(screen.queryByRole('button', { name: 'Use this resume' })).toBeNull();
  });

  it('the requires-attention line names the control only when the viewer has it', async () => {
    vi.mocked(getPipelineResumeEdition).mockResolvedValue(ARCHIVED_SELECTION);
    const { unmount } = render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection />);
    expect(await screen.findByTestId('resume-requires-attention')).toHaveTextContent('Choose “Use this resume”');
    unmount();
    render(<ResumeSelectionSection pipelineId={PIPE_ID} canSetSelection={false} />);
    const line = await screen.findByTestId('resume-requires-attention');
    expect(line).not.toHaveTextContent(/below/);
    expect(line).toHaveTextContent('An active resume must be chosen');
  });
});
