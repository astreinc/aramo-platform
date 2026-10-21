import { useState } from 'react';
import { DialogClose, Input, TextArea } from '@aramo/fe-foundation';

import { Button, Dialog, InlineAlert, RadioGroup } from '../ui';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.4 (S3, A1 AM-3) — Put on hold. The
// server REQUIRES a reason and a source (client | internal) on PUT_ON_HOLD; the action stays
// disabled until both are present. 'vms' is never offered: only a VMS event records it.
export interface PutOnHoldDetails {
  readonly reason: string;
  readonly source: 'client' | 'internal';
  readonly effective_at?: string;
  readonly instructions?: string | null;
}

export interface PutOnHoldDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Runs the status-changing PATCH; throws on a refusal (the caller's typed copy is shown). */
  readonly onConfirm: (details: PutOnHoldDetails) => Promise<void>;
  readonly errorMessage: (err: unknown) => string;
}

type HoldSourceChoice = 'client' | 'internal' | '';

const SOURCE_OPTIONS: ReadonlyArray<{ value: HoldSourceChoice; label: string }> = [
  { value: 'client', label: 'Client' },
  { value: 'internal', label: 'Internal' },
];

export function PutOnHoldDialog({ open, onOpenChange, onConfirm, errorMessage }: PutOnHoldDialogProps) {
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<HoldSourceChoice>('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = reason.trim().length > 0 && source !== '';

  const handleConfirm = async () => {
    if (busy || source === '' || reason.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        reason: reason.trim(),
        source,
        ...(effectiveDate.trim().length > 0 ? { effective_at: new Date(effectiveDate).toISOString() } : {}),
        instructions: instructions.trim().length > 0 ? instructions.trim() : null,
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
      onOpenChange={onOpenChange}
      title="Put requisition on hold"
      description="Recruiting and qualification may continue. Client submittals are unavailable until the requisition returns to Open."
      size="md"
      footer={
        <div className="sw-modal__footer">
          <DialogClose asChild>
            <Button variant="ghost" type="button">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleConfirm} disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Put on hold'}
          </Button>
        </div>
      }
    >
      <div className="sw-modal__section-label">Who placed the hold?</div>
      <RadioGroup
        name="req-hold-source"
        value={source}
        options={SOURCE_OPTIONS}
        onValueChange={(v) => setSource(v)}
      />
      <div className="sw-modal__fields">
        <label className="sw-field">
          <span className="sw-field__label">Reason</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Client hiring temporarily paused"
            aria-label="Hold reason"
          />
        </label>
        <label className="sw-field">
          <span className="sw-field__label">
            Effective date <span className="sw-field__opt">· optional</span>
          </span>
          <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </label>
        <label className="sw-field">
          <span className="sw-field__label">
            Account Manager instructions <span className="sw-field__opt">· optional</span>
          </span>
          <TextArea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
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
