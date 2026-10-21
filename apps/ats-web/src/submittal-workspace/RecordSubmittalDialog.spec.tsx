import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';

import { submitToClient } from '../submittals/submittals-api';

import { RecordSubmittalDialog } from './RecordSubmittalDialog';

// vi.mock is hoisted above the imports by vitest's transform.
vi.mock('../submittals/submittals-api', () => ({ submitToClient: vi.fn() }));
const submitMock = vi.mocked(submitToClient);

function renderDialog(over: Partial<Parameters<typeof RecordSubmittalDialog>[0]> = {}) {
  const onRecorded = vi.fn();
  const onRaceConflict = vi.fn();
  render(
    <RecordSubmittalDialog
      open
      onOpenChange={vi.fn()}
      submittalId="sub1"
      who="Divya Vasudevan"
      role="Scrum Master"
      client="Freddie Mac"
      resumeLabel={null}
      billRateLabel="$92.00 / hour"
      onRecorded={onRecorded}
      onRaceConflict={onRaceConflict}
      {...over}
    />,
  );
  return { onRecorded, onRaceConflict };
}

describe('RecordSubmittalDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers only the V1 manual delivery channels; never an automated connector', () => {
    renderDialog();
    expect(screen.getByText('Manual VMS')).toBeInTheDocument();
    expect(screen.getByText('Client portal')).toBeInTheDocument();
    expect(screen.getByText('Email (outside Aramo)')).toBeInTheDocument();
    expect(screen.getByText('Other manual method')).toBeInTheDocument();
    // No automated/outbound connector option in V1.
    expect(screen.queryByText(/Aramo connector/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fieldglass/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Beeline/i)).not.toBeInTheDocument();
  });

  it('the copy makes clear Aramo records (not sends) the handoff and does not confirm receipt', () => {
    renderDialog();
    expect(screen.getByText(/does not send anything to the client/i)).toBeInTheDocument();
    expect(screen.getByText(/does not confirm the client received it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record submittal' })).toBeInTheDocument();
  });

  it('INC-1d: Record is disabled until the handoff attestation is checked (no unattested send)', async () => {
    const { onRecorded } = renderDialog();
    const recordBtn = screen.getByRole('button', { name: 'Record submittal' });
    // Gated until attested.
    expect(recordBtn).toBeDisabled();
    fireEvent.click(recordBtn);
    expect(submitMock).not.toHaveBeenCalled();
    // Attest → enabled → sends.
    fireEvent.click(screen.getByRole('checkbox', { name: /performed this handoff/i }));
    expect(recordBtn).not.toBeDisabled();
    submitMock.mockResolvedValue({ submittal: { state: 'submitted_to_client' } } as never);
    fireEvent.click(recordBtn);
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0][1].handoff_performed).toBe(true);
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  });

  it('records with the SW-2 provenance DTO (delivery_channel + external_reference + ISO submitted_at) then refetches', async () => {
    submitMock.mockResolvedValue({ submittal: { state: 'submitted_to_client' } } as never);
    const { onRecorded, onRaceConflict } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText('e.g. FG-938273'), { target: { value: 'FG-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /performed this handoff/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Record submittal' }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    const [id, provenance, key] = submitMock.mock.calls[0];
    expect(id).toBe('sub1');
    // INC-1d — the mandatory handoff attestation rides in the provenance payload.
    expect(provenance.handoff_performed).toBe(true);
    expect(provenance.delivery_channel).toBe('manual_vms');
    expect(provenance.external_reference).toBe('FG-1');
    expect(typeof provenance.external_submitted_at).toBe('string');
    expect(() => new Date(provenance.external_submitted_at as string).toISOString()).not.toThrow();
    expect(typeof key).toBe('string');
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(onRaceConflict).not.toHaveBeenCalled();
  });

  it('a slot-race refusal (SUBMITTAL_LIMIT_REACHED) hands off to the authoritative refresh path — never optimistic success', async () => {
    submitMock.mockRejectedValue(new ApiError(409, 'limit reached', 'SUBMITTAL_LIMIT_REACHED'));
    const { onRecorded, onRaceConflict } = renderDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: /performed this handoff/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Record submittal' }));

    await waitFor(() => expect(onRaceConflict).toHaveBeenCalledTimes(1));
    expect(onRecorded).not.toHaveBeenCalled();
  });

  // Talent Lifecycle R1–R5 Impl Directive v1.2 §2.4 / §4.6 (D-5) — an UNRESOLVED RTR policy
  // refuses the submit; the dialog stays open with specific copy, never a false success.
  it('an UNRESOLVED RTR policy refusal shows the policy-not-set copy and records nothing', async () => {
    submitMock.mockRejectedValue(new ApiError(409, 'unresolved', 'SUBMITTAL_RTR_POLICY_UNRESOLVED'));
    const { onRecorded, onRaceConflict } = renderDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: /performed this handoff/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Record submittal' }));

    expect(await screen.findByText(/policy isn’t set for this client/)).toBeInTheDocument();
    expect(onRecorded).not.toHaveBeenCalled();
    expect(onRaceConflict).not.toHaveBeenCalled();
  });
});
