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

function renderModal(over: { onRecorded?: () => void; onClose?: () => void; sourceInteractionId?: string } = {}) {
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
        {...(over.sourceInteractionId === undefined ? {} : { sourceInteractionId: over.sourceInteractionId })}
        onRecorded={onRecorded}
        onClose={onClose}
      />
    </ToastProvider>,
  );
  return { onRecorded, onClose };
}

const recordBtn = () => screen.getByRole('button', { name: /Record response|Recording…|Try again/ });
// v1.2 §7.6 (S4) — a valid entry: the attestation checked + a note (no source interaction).
const attest = () => fireEvent.click(screen.getByRole('checkbox'));
const addNote = (text = 'Interested, available after Oct 20') =>
  fireEvent.change(screen.getByPlaceholderText(/What did they say|How did they respond/), { target: { value: text } });
const fillValid = (channel: string) => {
  fireEvent.click(screen.getByRole('radio', { name: channel }));
  addNote();
  attest();
};

describe('RecordTalentResponseModal', () => {
  beforeEach(() => {
    recordMock.mockReset();
    recordMock.mockResolvedValue({
      interaction_id: 'i1',
      deduped: false,
      pipeline_stage: 'talent_responded',
      pipeline_version: 2,
      advanced: true,
      occurred_at: '2026-10-20T10:00:00.000Z',
      recorded_at: '2026-10-20T10:05:00.000Z',
      recorded_by_id: 'u1',
    });
  });

  it('renders the modal with channel tiles, date/time, and the attested-account copy', () => {
    renderModal();
    expect(screen.getByText('Record Talent response')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Phone call' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Email' })).toBeTruthy();
    expect(screen.getByLabelText('Response date')).toBeTruthy();
    expect(screen.getByText(/Saved as your confirmation of the response/i)).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
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
    fillValid('Phone call');
    fireEvent.click(recordBtn());
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0]![0]).toMatchObject({
      pipeline_id: 'pipe-1',
      channel: 'phone',
      substantive_response_attested: true,
      note: 'Interested, available after Oct 20',
    });
    expect(recordMock.mock.calls[0]![0]).not.toHaveProperty('source_interaction_id');
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    // The modal imports ONLY the response-evidence client — no generic transition path exists.
  });

  it('5xx failure → values preserved, onRecorded NOT called, retry allowed (same idempotency key)', async () => {
    const { onRecorded } = renderModal();
    recordMock.mockRejectedValueOnce(new Error('network'));
    fillValid('Phone call');
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
    fillValid('Email');
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/journey changed while you were recording/i)).toBeTruthy();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('422 §-rule (response time precedes contact) → recruiter copy with the formatted first-contact time; raw server message NOT echoed (ATS-QA-1 D7)', async () => {
    const { onRecorded } = renderModal();
    const firstContact = '2026-10-18T09:30:00.000Z';
    recordMock.mockRejectedValueOnce(
      new ApiError(
        422,
        'occurred_at cannot precede the first recorded contact for this talent and requisition',
        'VALIDATION_ERROR',
        { field: 'occurred_at', first_contact_at: firstContact },
      ),
    );
    fillValid('Email');
    fireEvent.click(recordBtn());
    const expected = `Response time can’t be earlier than the first recorded contact (${new Date(firstContact).toLocaleString()}).`;
    expect(await screen.findByText(expected)).toBeTruthy();
    // The wire field name / raw server message is never shown…
    expect(screen.queryByText(/occurred_at/)).toBeNull();
    // …and the generic "couldn’t record" banner is NOT shown.
    expect(screen.queryByText(/Couldn’t record the response/i)).toBeNull();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('422 future response time → plain copy, raw server message NOT echoed (ATS-QA-1 D7)', async () => {
    renderModal();
    recordMock.mockRejectedValueOnce(
      new ApiError(422, 'occurred_at cannot be in the future', 'VALIDATION_ERROR', { field: 'occurred_at' }),
    );
    fillValid('Email');
    fireEvent.click(recordBtn());
    expect(await screen.findByText('Response time can’t be in the future.')).toBeTruthy();
    expect(screen.queryByText(/occurred_at/)).toBeNull();
  });

  it('400 without a field → generic plain copy, raw server message NOT echoed (ATS-QA-1 D7)', async () => {
    renderModal();
    recordMock.mockRejectedValueOnce(new ApiError(400, 'occurred_at must be an ISO 8601 date string', 'VALIDATION_ERROR'));
    fillValid('Email');
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/Some details weren’t accepted/)).toBeTruthy();
    expect(screen.queryByText(/occurred_at/)).toBeNull();
  });

  // ---- Talent Lifecycle R1–R5 v1.2 §7.6 (S4) ----
  it('the attestation is required — unchecked shows an error and calls NO API', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Phone call' }));
    addNote();
    fireEvent.click(recordBtn());
    expect(await screen.findByText('Confirm the Talent gave a real response.')).toBeTruthy();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('with no source interaction, a note is required (the attestation alone never suffices)', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Phone call' }));
    attest();
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/Add a short note/i)).toBeTruthy();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('opened from an interaction: sends source_interaction_id and the note is optional', async () => {
    const { onRecorded } = renderModal({ sourceInteractionId: 'int-9' });
    fireEvent.click(screen.getByRole('radio', { name: 'Phone call' }));
    attest();
    fireEvent.click(recordBtn());
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0]![0]).toMatchObject({ source_interaction_id: 'int-9', substantive_response_attested: true });
    expect(recordMock.mock.calls[0]![0]).not.toHaveProperty('note');
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  });

  it('shows the reviewer and the recorded time on success; a historical record says the journey does not move', async () => {
    recordMock.mockResolvedValueOnce({
      interaction_id: 'i2',
      deduped: false,
      pipeline_stage: 'no_contact',
      pipeline_version: 0,
      advanced: false,
      occurred_at: '2026-10-19T10:00:00.000Z',
      recorded_at: '2026-10-20T10:05:00.000Z',
      recorded_by_id: 'u1',
    });
    renderModal();
    fillValid('Email');
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/Response recorded by you · .* kept as history/)).toBeTruthy();
  });

  it('a non-substantive source refusal shows specific copy (not the stale-journey banner)', async () => {
    recordMock.mockRejectedValueOnce(
      new ApiError(422, 'x', 'PIPELINE_EVIDENCE_INADMISSIBLE', { reason: 'source_not_substantive' }),
    );
    renderModal({ sourceInteractionId: 'int-9' });
    fireEvent.click(screen.getByRole('radio', { name: 'Phone call' }));
    attest();
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/wasn’t a real response/)).toBeTruthy();
  });

  it('a closed-requisition refusal (409 REQUISITION_NOT_ADVANCEABLE) shows specific copy, not the stale banner', async () => {
    recordMock.mockRejectedValueOnce(new ApiError(409, 'x', 'REQUISITION_NOT_ADVANCEABLE'));
    renderModal();
    fillValid('Email');
    fireEvent.click(recordBtn());
    expect(await screen.findByText(/happened before the requisition closed/)).toBeTruthy();
    expect(screen.queryByText(/journey changed while you were recording/i)).toBeNull();
  });
});
