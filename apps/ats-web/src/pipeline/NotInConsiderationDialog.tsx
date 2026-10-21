import { useState } from 'react';
import { DialogClose, TextArea } from '@aramo/fe-foundation';

import { Button, Dialog, InlineAlert, RadioGroup } from '../ui';
import { DISPOSITION_REASON_LABELS } from '../talent-360/t360-vocab';

import { RECRUITER_DISPOSITION_REASON_GROUPS, authorityForReason, type RecruiterDispositionAuthority } from './disposition-reasons';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R1 (DEF-6; Lane2-C :87, A1-TE TE-5) — take a
// Talent off this requisition as Not in consideration, WITH a reason (required) and an optional
// note. The backend is authoritative (governed DISPOSITION action); this dialog only collects the
// reason and surfaces a typed refusal.
export interface NotInConsiderationChoice {
  readonly authority_class: RecruiterDispositionAuthority;
  readonly reason: string;
  readonly note?: string;
}

export interface NotInConsiderationDialogProps {
  readonly open: boolean;
  readonly talentName: string;
  readonly onOpenChange: (open: boolean) => void;
  /** Runs the DISPOSITION action; throws on a refusal (the caller's typed copy is shown). */
  readonly onConfirm: (choice: NotInConsiderationChoice) => Promise<void>;
  readonly errorMessage: (err: unknown) => string;
}

const NOTE_MAX = 500;

export function NotInConsiderationDialog({ open, talentName, onOpenChange, onConfirm, errorMessage }: NotInConsiderationDialogProps) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authority = reason === '' ? null : authorityForReason(reason);

  const handleConfirm = async () => {
    if (busy || authority === null) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        authority_class: authority,
        reason,
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Mark as Not in consideration"
      description={`${talentName} leaves this requisition’s active pipeline. The reason is recorded and can’t be changed later.`}
      size="md"
      footer={
        <div className="sw-modal__footer">
          <DialogClose asChild>
            <Button variant="ghost" type="button" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleConfirm} disabled={busy || authority === null}>
            {busy ? 'Saving…' : 'Mark Not in consideration'}
          </Button>
        </div>
      }
    >
      {RECRUITER_DISPOSITION_REASON_GROUPS.map((group) => (
        <div key={group.authority}>
          <div className="sw-modal__section-label">{group.label}</div>
          <RadioGroup
            name={`nic-reason-${group.authority}`}
            value={group.reasons.includes(reason) ? reason : ''}
            options={group.reasons.map((r) => ({ value: r, label: DISPOSITION_REASON_LABELS[r] ?? r }))}
            onValueChange={(v) => {
              setReason(v);
              setError(null);
            }}
            disabled={busy}
          />
        </div>
      ))}
      <div className="sw-modal__fields">
        <label className="sw-field">
          <span className="sw-field__label">
            Note <span className="sw-field__opt">· optional</span>
          </span>
          <TextArea
            value={note}
            rows={3}
            maxLength={NOTE_MAX}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note"
          />
        </label>
      </div>
      {error !== null ? (
        <div className="sw-modal__error">
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      ) : null}
    </Dialog>
  );
}
