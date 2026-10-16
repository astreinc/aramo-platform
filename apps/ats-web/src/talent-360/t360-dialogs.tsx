import { Dialog, InlineAlert, Input, Select, TextArea } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import { createNote } from '../activity/activity-api';
import { createTask } from '../task/task-api';
import { Button } from '../ui';
import { fetchAssignableUsers, type AssignableUser } from '../users/users-api';

// Talent 360 dialogs — moved verbatim from the previous Talent360View so the
// redesigned page keeps the SAME governed mutations (createTask / createNote).

// §9.3/§10 — the follow-up create affordance (shared by the header "Follow up"
// action and the Tasks card). A REAL task: owner_type talent_record, type
// follow_up. CRM-6 — full modal: Reason + When + Assign-to (defaults to the
// ACTOR here on the FE so the task lands on their My Desk — the backend does
// NOT default a missing assignee) + optional Requisition context.
// CRM-6 req-option: the Talent's OWN active opportunities are the only valid
// requisition contexts (the backend validates the Talent↔Requisition pipeline
// relationship and 422s otherwise), so the picker is fed from them — no all-reqs
// fetch, no invalid choices.
export interface FollowUpReqOption {
  readonly requisition_id: string;
  readonly label: string;
}

export function FollowUpDialog({
  talentId,
  myId,
  reqOptions,
  onClose,
  onDone,
}: {
  talentId: string;
  myId: string | null;
  reqOptions: readonly FollowUpReqOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [due, setDue] = useState('');
  // CRM-6 — assignee defaults to the actor (prototype "Me"); this is what makes
  // the follow-up land on the creator's My Desk (the CRM-5 path left it null).
  const [assigneeId, setAssigneeId] = useState<string>(myId ?? '');
  const [reqId, setReqId] = useState<string>('');
  const [roster, setRoster] = useState<readonly AssignableUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAssignableUsers()
      .then((u) => {
        if (!cancelled) setRoster(u);
      })
      .catch(() => {
        // Fail-soft: assignee defaults to self even if the roster can't load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(): Promise<void> {
    if (reason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        title: reason.trim(),
        owner_type: 'talent_record',
        owner_id: talentId,
        type: 'follow_up',
        ...(due === '' ? {} : { due_date: due }),
        ...(assigneeId === '' ? {} : { assignee_id: assigneeId }),
        ...(reqId === '' ? {} : { requisition_id: reqId }),
      });
      onDone();
    } catch {
      setError('Couldn’t create the follow-up. Please try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Follow up"
      description="Create a follow-up task for this person."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || reason.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create follow-up'}
          </Button>
        </>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <label className="talent-detail__dialog-field">
        <span>Reason</span>
        <TextArea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What's the next step?"
          rows={2}
          className="t360-textarea"
          aria-label="Follow-up reason"
        />
      </label>
      <label className="talent-detail__dialog-field">
        <span>When (optional)</span>
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Follow-up due date" />
      </label>
      <label className="talent-detail__dialog-field">
        <span>Assign to</span>
        <Select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          aria-label="Follow-up assignee"
        >
          <option value={myId ?? ''}>Me</option>
          {roster
            .filter((u) => u.user_id !== myId)
            .map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {u.display_name}
              </option>
            ))}
        </Select>
      </label>
      {reqOptions.length > 0 ? (
        <label className="talent-detail__dialog-field">
          <span>Requisition (optional)</span>
          <Select
            value={reqId}
            onChange={(e) => setReqId(e.target.value)}
            aria-label="Follow-up requisition"
          >
            <option value="">None</option>
            {reqOptions.map((r) => (
              <option key={r.requisition_id} value={r.requisition_id}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </Dialog>
  );
}

// Thin Log-activity dialog over the EXISTING authoritative mutation
// (POST /v1/activities via createNote, activity:create). Talent-subject note
// only; exposes only CreateActivityRequestDto-supported fields — no new activity
// type, no Talent-specific backend mutation (directive §4; PO ruling).
export function LogActivityDialog({ talentId, onClose }: { talentId: string; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = () => {
    const text = notes.trim();
    if (text === '') return;
    setBusy(true);
    setErr(null);
    createNote({ type: 'note', subject_type: 'talent_record', subject_id: talentId, notes: text })
      .then(() => {
        setBusy(false);
        setDone(true);
      })
      .catch(() => {
        setBusy(false);
        setErr('We couldn’t log this activity. Please try again.');
      });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Log activity"
    >
      {done ? (
        <>
          <InlineAlert variant="success">Activity logged.</InlineAlert>
          <div className="talent-detail__dialog-actions">
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <label className="talent-detail__dialog-field">
            <span>Note</span>
            <TextArea
              unstyled
              className="t360-textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              aria-label="Activity note"
              placeholder="What happened?"
            />
          </label>
          {err !== null && <InlineAlert variant="error">{err}</InlineAlert>}
          <div className="talent-detail__dialog-actions">
            <Button variant="primary" onClick={save} disabled={notes.trim() === '' || busy}>
              {busy ? 'Logging…' : 'Log activity'}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

