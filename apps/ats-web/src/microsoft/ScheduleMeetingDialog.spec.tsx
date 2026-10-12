import { ApiError } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleMeetingDialog } from './ScheduleMeetingDialog';
import { instantToZonedWallClock } from './calendar-meeting-tz';
import type { ScheduledMeetingView } from './microsoft-api';

const MACHINE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const VIEW: ScheduledMeetingView = {
  interaction_id: 'int-1',
  operation_id: 'op-1',
  provider_event_id: 'evt-1',
  join_url: 'https://teams.example/join',
  status: 'scheduled',
  version: 0,
  scheduled_start: '2026-11-03T15:00:00.000Z',
  scheduled_end: '2026-11-03T15:30:00.000Z',
  idempotent_replay: false,
};

function fillValidForm(): void {
  fireEvent.change(screen.getByTestId('schedule-date'), { target: { value: '2026-11-03' } });
  fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '10:00' } });
  fireEvent.change(screen.getByTestId('schedule-subject'), { target: { value: 'Recruiter screen' } });
}

describe('ScheduleMeetingDialog', () => {
  it('review-before-send: submitting the form shows a review; it does NOT call the API on open or on review', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    render(
      <ScheduleMeetingDialog
        open
        onOpenChange={vi.fn()}
        talentId="tal-1"
        talentName="Dana Lee"
        requisitionId="req-1"
        scheduleFn={scheduleFn}
        onDone={vi.fn()}
      />,
    );
    // opening the dialog must never transmit
    expect(scheduleFn).not.toHaveBeenCalled();
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    // a review summary appears; still no API call
    expect(await screen.findByTestId('schedule-review-summary')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-review-summary').textContent).toMatch(/invitation/i);
    expect(scheduleFn).not.toHaveBeenCalled();
  });

  it('confirming the review calls scheduleFn with a composed DTO incl. a non-empty IANA time_zone and idempotency_key', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    const onDone = vi.fn();
    render(
      <ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" pipelineId="pl-1" scheduleFn={scheduleFn} onDone={onDone} />,
    );
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    const dto = scheduleFn.mock.calls[0][0];
    expect(dto.talent_record_id).toBe('tal-1');
    expect(dto.requisition_id).toBe('req-1');
    expect(dto.pipeline_id).toBe('pl-1');
    expect(dto.subject).toBe('Recruiter screen');
    expect(typeof dto.time_zone).toBe('string');
    expect(dto.time_zone.length).toBeGreaterThan(0); // validated IANA, never empty
    expect(dto.idempotency_key.length).toBeGreaterThanOrEqual(8);
    expect(dto.start_date_time).toMatch(/2026-11-03T10:00/);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(VIEW));
  });

  it('idempotency key is STABLE across a failed-then-retry of an unchanged request', async () => {
    const scheduleFn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, 'x', 'MICROSOFT_PROVIDER_ERROR'))
      .mockResolvedValueOnce(VIEW);
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    // retry the SAME unchanged request
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(2));
    expect(scheduleFn.mock.calls[0][0].idempotency_key).toBe(scheduleFn.mock.calls[1][0].idempotency_key);
  });

  it('timezone is a validated selection (a <select>), never a free-text input', () => {
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={vi.fn()} onDone={vi.fn()} />);
    const tz = screen.getByTestId('schedule-timezone');
    expect(tz.tagName).toBe('SELECT');
    expect((tz as HTMLSelectElement).value.length).toBeGreaterThan(0); // a concrete default IANA zone
  });

  it('edit mode calls rescheduleFn with expected_version from the meeting', async () => {
    const rescheduleFn = vi.fn().mockResolvedValue({ ...VIEW, status: 'rescheduled', version: 1 });
    render(
      <ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" editing={VIEW} rescheduleFn={rescheduleFn} onDone={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '11:00' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(rescheduleFn).toHaveBeenCalledTimes(1));
    expect(rescheduleFn.mock.calls[0][0]).toBe('int-1');
    expect(rescheduleFn.mock.calls[0][1].expected_version).toBe(0);
  });

  it('FIX_NOW-1: start/end are OFFSET-BEARING ISO-8601 instants, not bare local strings', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('schedule-date'), { target: { value: '2026-11-03' } });
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByTestId('schedule-subject'), { target: { value: 'Recruiter screen' } });
    // force a known zone so the offset is deterministic
    fireEvent.change(screen.getByTestId('schedule-timezone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    expect(scheduleFn.mock.calls[0][0].start_date_time).toBe('2026-11-03T10:00:00-05:00');
    expect(scheduleFn.mock.calls[0][0].end_date_time).toBe('2026-11-03T10:30:00-05:00');
  });

  it('FIX_NOW-1: a DST-nonexistent local time blocks review (not silently shifted)', () => {
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('schedule-timezone'), { target: { value: 'America/New_York' } });
    fireEvent.change(screen.getByTestId('schedule-date'), { target: { value: '2026-03-08' } });
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '02:30' } });
    fireEvent.change(screen.getByTestId('schedule-subject'), { target: { value: 'Recruiter screen' } });
    expect(screen.getByTestId('schedule-dst-error')).toBeInTheDocument();
    expect((screen.getByTestId('schedule-review') as HTMLButtonElement).disabled).toBe(true);
  });

  it('FIX_NOW-2: reschedule initializes date/time in the selected zone (not UTC)', () => {
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" editing={VIEW} rescheduleFn={vi.fn()} getFn={vi.fn()} onDone={vi.fn()} />);
    // VIEW.scheduled_start = 2026-11-03T15:00Z. If the machine's zone is UTC the field
    // reads 15:00; the point is it is the zoned wall clock, never a raw slice mismatch.
    const w = instantToZonedWallClock('2026-11-03T15:00:00.000Z', MACHINE_ZONE);
    expect((screen.getByTestId('schedule-time') as HTMLInputElement).value).toBe(w.time);
  });

  it('FIX_NOW-3: a version conflict refreshes authoritative state and resubmits with the FRESH version', async () => {
    const rescheduleFn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'x', 'MICROSOFT_MEETING_VERSION_CONFLICT'))
      .mockResolvedValueOnce({ ...VIEW, status: 'rescheduled', version: 8 });
    const getFn = vi.fn().mockResolvedValue({ ...VIEW, version: 7 });
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" editing={VIEW} rescheduleFn={rescheduleFn} getFn={getFn} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '12:00' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    // conflict → refresh fetched, dialog returns to the form with a notice
    await waitFor(() => expect(getFn).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('schedule-refreshed-notice')).toBeInTheDocument();
    // fresh review + confirm → resubmits with the refreshed version (7), not the stale 0
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(rescheduleFn).toHaveBeenCalledTimes(2));
    expect(rescheduleFn.mock.calls[0][1].expected_version).toBe(0);
    expect(rescheduleFn.mock.calls[1][1].expected_version).toBe(7);
  });

  it('FIX_NOW-3: if the refresh itself fails, an explicit error is shown and no blind retry is offered', async () => {
    const rescheduleFn = vi.fn().mockRejectedValue(new ApiError(409, 'x', 'MICROSOFT_MEETING_VERSION_CONFLICT'));
    const getFn = vi.fn().mockRejectedValue(new ApiError(404, 'x', 'MICROSOFT_MEETING_NOT_FOUND'));
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" editing={VIEW} rescheduleFn={rescheduleFn} getFn={getFn} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '12:00' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    expect(await screen.findByTestId('schedule-error')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-confirm')).toBeNull(); // no blind retry
  });

  // ── Residual FIX_NOW: state isolation across a REUSED dialog instance ──
  const A: ScheduledMeetingView = { ...VIEW, interaction_id: 'A', version: 3, scheduled_start: '2026-11-03T15:00:00.000Z', scheduled_end: '2026-11-03T15:30:00.000Z' };
  const B: ScheduledMeetingView = { ...VIEW, interaction_id: 'B', version: 9, scheduled_start: '2026-12-01T18:00:00.000Z', scheduled_end: '2026-12-01T18:45:00.000Z' };

  it('reschedule A → close → reschedule B targets B (fresh id + version, no leak)', async () => {
    const rescheduleFn = vi.fn().mockResolvedValue(B);
    const { rerender } = render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={A} rescheduleFn={rescheduleFn} onDone={vi.fn()} />);
    rerender(<ScheduleMeetingDialog open={false} onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={A} rescheduleFn={rescheduleFn} onDone={vi.fn()} />);
    rerender(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={B} rescheduleFn={rescheduleFn} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(rescheduleFn).toHaveBeenCalledTimes(1));
    expect(rescheduleFn.mock.calls[0][0]).toBe('B');
    expect(rescheduleFn.mock.calls[0][1].expected_version).toBe(9);
  });

  it('reschedule A → close → create does NOT carry A\'s id (create path, form reset)', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    const rescheduleFn = vi.fn();
    const { rerender } = render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={A} scheduleFn={scheduleFn} rescheduleFn={rescheduleFn} onDone={vi.fn()} />);
    rerender(<ScheduleMeetingDialog open={false} onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={A} scheduleFn={scheduleFn} rescheduleFn={rescheduleFn} onDone={vi.fn()} />);
    rerender(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={null} defaultDate="2026-10-20" scheduleFn={scheduleFn} rescheduleFn={rescheduleFn} onDone={vi.fn()} />);
    // Create mode prefills (tomorrow / supplied default) — A's edit date must NOT leak.
    expect((screen.getByTestId('schedule-date') as HTMLInputElement).value).toBe('2026-10-20');
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    expect(rescheduleFn).not.toHaveBeenCalled();
  });

  it('create → close → create issues a FRESH idempotency key for the new session (same inputs)', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    const { rerender } = render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    rerender(<ScheduleMeetingDialog open={false} onOpenChange={vi.fn()} talentId="t" requisitionId="r" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    rerender(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fillValidForm(); // identical inputs, new session
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(2));
    expect(scheduleFn.mock.calls[0][0].idempotency_key).not.toBe(scheduleFn.mock.calls[1][0].idempotency_key);
  });

  it('a refreshed-notice from a prior session does not persist after close → reopen', async () => {
    const rescheduleFn = vi.fn().mockRejectedValue(new ApiError(409, 'x', 'MICROSOFT_MEETING_VERSION_CONFLICT'));
    const getFn = vi.fn().mockResolvedValue({ ...A, version: 4 });
    const { rerender } = render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={A} rescheduleFn={rescheduleFn} getFn={getFn} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    expect(await screen.findByTestId('schedule-refreshed-notice')).toBeInTheDocument();
    rerender(<ScheduleMeetingDialog open={false} onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={A} rescheduleFn={rescheduleFn} getFn={getFn} onDone={vi.fn()} />);
    rerender(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="t" requisitionId="r" editing={B} rescheduleFn={rescheduleFn} getFn={getFn} onDone={vi.fn()} />);
    expect(screen.queryByTestId('schedule-refreshed-notice')).toBeNull();
  });

  it('an UNRESOLVED error shows the uncertain-outcome message and offers NO retry', async () => {
    const scheduleFn = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'x', 'MICROSOFT_SCHEDULING_UNRESOLVED', { operation_id: 'op-x' }));
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    const err = await screen.findByTestId('schedule-error');
    expect(err.textContent).toMatch(/could not be confirmed|not confirmed/i);
    expect(err.textContent).toMatch(/op-x/);
    expect(screen.queryByTestId('schedule-confirm')).toBeNull(); // no blind retry affordance
  });
});
