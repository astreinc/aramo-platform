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

  it('the copy makes clear Aramo records (not sends) the handoff', () => {
    renderDialog();
    expect(screen.getByText(/does not send anything to the client/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record submittal' })).toBeInTheDocument();
  });

  it('records with the SW-2 provenance DTO (delivery_channel + external_reference + ISO submitted_at) then refetches', async () => {
    submitMock.mockResolvedValue({ submittal: { state: 'submitted_to_client' } } as never);
    const { onRecorded, onRaceConflict } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText('e.g. FG-938273'), { target: { value: 'FG-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record submittal' }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    const [id, provenance, key] = submitMock.mock.calls[0];
    expect(id).toBe('sub1');
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

    fireEvent.click(screen.getByRole('button', { name: 'Record submittal' }));

    await waitFor(() => expect(onRaceConflict).toHaveBeenCalledTimes(1));
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
