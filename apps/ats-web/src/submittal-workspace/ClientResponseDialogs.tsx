import { useState } from 'react';
import { ApiError, Input, TextArea } from '@aramo/fe-foundation';

import { Button, Dialog, InlineAlert, RadioGroup, safeErrorMessage } from '../ui';
import { scheduleInterview } from '../interviews/interviews-api';

import { decideClientSelection, transitionClientSelection } from './client-selection-api';
import { withdrawReasonLabel } from './present';
import { WITHDRAW_REASON_CODES, type WithdrawReasonCode } from './submittal-workspace-types';

// SW-6 — governed client-response action dialogs. Every mutation echoes the
// optimistic-concurrency version; the backend enforces legality/scope/closed reasons.
// A stale version → 409 CLIENT_SELECTION_TRANSITION_CONFLICT, handed to onConflict
// (the page refetches authoritative truth — never an optimistic local state change).

export type ClientSelectionActionKind = 'move_to_interview' | 'mark_selected' | 'decline' | 'withdraw';

interface ActionSpec {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly to_state: 'INTERVIEW' | 'SELECTED' | 'DECLINED' | 'WITHDRAWN';
  readonly via: 'transition' | 'decision';
  readonly needsReason: boolean;
  readonly allowsNote: boolean;
}

const ACTION_SPEC: Record<ClientSelectionActionKind, ActionSpec> = {
  move_to_interview: { title: 'Move to interview', body: 'Record that the client has moved this talent to an interview stage.', confirmLabel: 'Move to interview', to_state: 'INTERVIEW', via: 'transition', needsReason: false, allowsNote: false },
  mark_selected: { title: 'Record selection', body: 'Record that the client selected this talent. This does not create an offer or placement.', confirmLabel: 'Record selected', to_state: 'SELECTED', via: 'transition', needsReason: false, allowsNote: false },
  decline: { title: 'Record decline', body: 'Record that the client declined this talent. You may add a note for the record.', confirmLabel: 'Record declined', to_state: 'DECLINED', via: 'decision', needsReason: false, allowsNote: true },
  withdraw: { title: 'Withdraw from client', body: 'Withdraw this talent from client consideration. This is distinct from revoking the submittal. A reason is required.', confirmLabel: 'Withdraw', to_state: 'WITHDRAWN', via: 'decision', needsReason: true, allowsNote: true },
};

const REASON_OPTIONS = WITHDRAW_REASON_CODES.map((c) => ({ value: c, label: withdrawReasonLabel(c) }));

interface ClientSelectionActionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly kind: ClientSelectionActionKind;
  readonly processId: string;
  readonly version: number;
  readonly onDone: () => void;
  readonly onConflict: () => void;
}

export function ClientSelectionActionDialog({ open, onOpenChange, kind, processId, version, onDone, onConflict }: ClientSelectionActionDialogProps) {
  const spec = ACTION_SPEC[kind];
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<WithdrawReasonCode>(WITHDRAW_REASON_CODES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const trimmedNote = note.trim().length > 0 ? note.trim() : undefined;
      if (spec.via === 'transition') {
        await transitionClientSelection(processId, { to_state: spec.to_state as 'INTERVIEW' | 'SELECTED', expected_version: version, note: trimmedNote });
      } else {
        await decideClientSelection(processId, {
          to_state: spec.to_state as 'DECLINED' | 'WITHDRAWN',
          expected_version: version,
          ...(spec.needsReason ? { reason_code: reason } : {}),
          note: trimmedNote,
        });
      }
      onOpenChange(false);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'CLIENT_SELECTION_TRANSITION_CONFLICT' || err.status === 409)) {
        onOpenChange(false);
        onConflict();
        return;
      }
      setError(safeErrorMessage(err, 'Couldn’t record the client response. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={spec.title}
      description={spec.body}
      size="sm"
      footer={
        <div className="sw-modal__footer">
          <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={run} disabled={busy}>{busy ? 'Recording…' : spec.confirmLabel}</Button>
        </div>
      }
    >
      {spec.needsReason ? (
        <div className="sw-cr-field">
          <span className="sw-field__label">Reason</span>
          <RadioGroup name="sw-withdraw-reason" value={reason} options={REASON_OPTIONS} onValueChange={(v) => setReason(v)} />
        </div>
      ) : null}
      {spec.allowsNote ? (
        <label className="sw-field sw-cr-field">
          <span className="sw-field__label">Note <span className="sw-field__opt">· optional</span></span>
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </label>
      ) : null}
      {error !== null ? <div className="sw-modal__error"><InlineAlert variant="error">{error}</InlineAlert></div> : null}
    </Dialog>
  );
}

function localNowValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ScheduleInterviewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly processId: string;
  readonly defaultRound: number;
  readonly onDone: () => void;
  readonly onConflict: () => void;
}

// Schedule the FIRST (or next) interview session. Independent of the process state
// (scheduling does NOT move the process to INTERVIEW — that is a separate command).
// Reuses the existing governed schedule contract (Idempotency-Key minted in the api).
export function ScheduleInterviewDialog({ open, onOpenChange, processId, defaultRound, onDone, onConflict }: ScheduleInterviewDialogProps) {
  const [interviewType, setInterviewType] = useState('Client interview');
  const [scheduledAt, setScheduledAt] = useState(localNowValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = interviewType.trim().length > 0 && scheduledAt.trim().length > 0 && !busy;

  const run = async () => {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      await scheduleInterview(processId, {
        interview_type: interviewType.trim(),
        scheduled_at: new Date(scheduledAt).toISOString(),
        round: defaultRound,
      });
      onOpenChange(false);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onOpenChange(false);
        onConflict();
        return;
      }
      setError(safeErrorMessage(err, 'Couldn’t schedule the interview. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Schedule interview"
      description="Record a client interview for this talent. Manage rounds, outcome and feedback from the interview detail."
      size="sm"
      footer={
        <div className="sw-modal__footer">
          <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={run} disabled={!canSubmit}>{busy ? 'Scheduling…' : 'Schedule interview'}</Button>
        </div>
      }
    >
      <label className="sw-field sw-cr-field">
        <span className="sw-field__label">Interview type</span>
        <Input value={interviewType} onChange={(e) => setInterviewType(e.target.value)} placeholder="e.g. Client panel" />
      </label>
      <label className="sw-field sw-cr-field">
        <span className="sw-field__label">Scheduled at</span>
        <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
      </label>
      {error !== null ? <div className="sw-modal__error"><InlineAlert variant="error">{error}</InlineAlert></div> : null}
    </Dialog>
  );
}
