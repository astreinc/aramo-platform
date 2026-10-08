import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';

import { recordTalentResponse } from './talent-response-api';
import { RecordTalentResponseModal } from './RecordTalentResponseModal';

// §7/§15/§23 (FE) — the ONE shared Record-Talent-Response modal. It records recruiter-
// attested evidence via the response-evidence API and NEVER calls a generic pipeline
// transition; on success the caller refetches canonical journey state.

vi.mock('./talent-response-api', async () => {
  const actual = await vi.importActual<typeof import('./talent-response-api')>('./talent-response-api');
  return { ...actual, recordTalentResponse: vi.fn() };
});
const recordMock = vi.mocked(recordTalentResponse);

// Structural guard — the modal must not import the generic pipeline transition client.
vi.mock('../pipeline/pipeline-api', () => ({
  transitionPipeline: vi.fn(() => {
    throw new Error('generic pipeline transition must NEVER be called from the response modal');
  }),
}));

function renderModal(over: { onRecorded?: () => void; onClose?: () => void } = {}) {
  const onRecorded = over.onRecorded ?? vi.fn();
  const onClose = over.onClose ?? vi.fn();
  render(
    <ToastProvider>
      <RecordTalentResponseModal
        open
        pipelineId="pipe-1"
        talentName="Ravi Shankar"
        reqCode="REQ-1001"
        contactNote="contacted Oct 5 by email"
        onRecorded={onRecorded}
        onClose={onClose}
      />
    </ToastProvider>,
  );
  return { onRecorded, onClose };
}

const recordBtn = () => screen.getByRole('button', { name: /Record response|Recording…|Try again/ });

describe('RecordTalentResponseModal', () => {
  beforeEach(() => {
    recordMock.mockReset();
    recordMock.mockResolvedValue({ interaction_id: 'i1', deduped: false, pipeline_stage: 'talent_responded', pipeline_version: 2 });
  });

  it('renders the modal with channel tiles, date/time, and the attested-account copy', () => {
    renderModal();
    expect(screen.getByText('Record Talent response')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Phone call' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Email' })).toBeTruthy();
    expect(screen.getByLabelText('Response date')).toBeTruthy();
    expect(screen.getByText(/attested account of the response/i)).toBeTruthy();
  });

  it('channel is required — submitting with no channel shows an error and calls NO API', async () => {
    renderModal();
    fireEvent.click(recordBtn());
    expect(await screen.findByText('Choose how the Talent responded.')).toBeTruthy();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('channel=Other requires a note', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/Add a short note/i)).toBeTruthy();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('success → calls the response-evidence API (phone→voice), fires onRecorded, and NEVER a generic transition', async () => {
    const { onRecorded } = renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Phone call' }));
    fireEvent.click(recordBtn());
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0]![0]).toMatchObject({ pipeline_id: 'pipe-1', channel: 'phone' });
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    // The modal imports ONLY the response-evidence client — no generic transition path exists.
  });

  it('5xx failure → values preserved, onRecorded NOT called, retry allowed (same idempotency key)', async () => {
    const { onRecorded } = renderModal();
    recordMock.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByRole('radio', { name: 'Phone call' }));
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/Couldn’t record the response/i)).toBeTruthy();
    expect(onRecorded).not.toHaveBeenCalled();
    // Values preserved: the channel is still selected.
    expect(screen.getByRole('radio', { name: 'Phone call' }).getAttribute('aria-checked')).toBe('true');
    // Retry → resolves.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    // Idempotency: both attempts carried the SAME key (retry dedupes, not double-records).
    expect(recordMock).toHaveBeenCalledTimes(2);
    expect(recordMock.mock.calls[0]![1]).toBe(recordMock.mock.calls[1]![1]);
  });

  it('409 stale journey → shows the "journey changed" banner (stage unchanged; close to refetch)', async () => {
    const { onRecorded } = renderModal();
    recordMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'PIPELINE_TRANSITION_CONFLICT'));
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/journey changed while you were recording/i)).toBeTruthy();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('422 §-rule (response time precedes contact) → surfaces the server reason inline, NOT the generic banner', async () => {
    const { onRecorded } = renderModal();
    recordMock.mockRejectedValueOnce(
      new ApiError(
        422,
        'occurred_at cannot precede the first recorded contact for this talent and requisition',
        'VALIDATION_ERROR',
      ),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(recordBtn());
    // The specific server reason is shown so the recruiter can correct the time…
    expect(await screen.findByText(/cannot precede the first recorded contact/i)).toBeTruthy();
    // …and the generic "couldn’t record" banner is NOT shown.
    expect(screen.queryByText(/Couldn’t record the response/i)).toBeNull();
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
