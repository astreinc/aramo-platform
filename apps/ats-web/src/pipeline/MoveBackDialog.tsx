import { useState } from 'react';
import { DialogClose, TextArea } from '@aramo/fe-foundation';

import { Button, Dialog, InlineAlert } from '../ui';

import { PIPELINE_STATUS_LABELS, type PipelineStatus } from './types';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R4 (DEF-15(f); D-2 Option A; A1-TE TE-1) — the
// governed backward CORRECTION. The 4 backward edges of the Lane2-C matrix, each with a REQUIRED
// note. Moving back into Contacted / Talent responded is allowed only when this episode already
// reached that stage — the server checks; this dialog collects the note and shows its refusal.
export const BACKWARD_TARGET: Readonly<Partial<Record<PipelineStatus, PipelineStatus>>> = {
  contacted: 'no_contact',
  talent_responded: 'contacted',
  qualifying: 'talent_responded',
  qualified: 'qualifying',
};

export interface MoveBackDialogProps {
  readonly open: boolean;
  readonly talentName: string;
  readonly from: PipelineStatus;
  readonly onOpenChange: (open: boolean) => void;
  /** Runs the transition with the note; throws on a refusal (typed copy shown). */
  readonly onConfirm: (to: PipelineStatus, note: string) => Promise<void>;
  readonly errorMessage: (err: unknown) => string;
}

const NOTE_MAX = 500;

export function MoveBackDialog({ open, talentName, from, onOpenChange, onConfirm, errorMessage }: MoveBackDialogProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const to = BACKWARD_TARGET[from];
  if (to === undefined) return null;

  const handleConfirm = async () => {
    if (busy || note.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(to, note.trim());
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
      title={`Move back to ${PIPELINE_STATUS_LABELS[to]}`}
      description={`Correct ${talentName}’s stage from ${PIPELINE_STATUS_LABELS[from]} to ${PIPELINE_STATUS_LABELS[to]}. The note is kept with the history.`}
      size="md"
      footer={
        <div className="sw-modal__footer">
          <DialogClose asChild>
            <Button variant="ghost" type="button" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleConfirm} disabled={busy || note.trim().length === 0}>
            {busy ? 'Saving…' : 'Move back'}
          </Button>
        </div>
      }
    >
      <div className="sw-modal__fields">
        <label className="sw-field">
          <span className="sw-field__label">Why is this being corrected?</span>
          <TextArea
            value={note}
            rows={3}
            maxLength={NOTE_MAX}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Correction note"
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
