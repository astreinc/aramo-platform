import { Button, Dialog, FormField, InlineAlert, RadioGroup, type RadioOption, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import {
  FALLOFF_REASON_CODES,
  FALLOFF_REASON_LABELS,
  type FalloffReasonCode,
} from './falloff-reason-labels';
import { recordFalloff } from './permanent-placement-api';
import { falloffErrorMessage } from './permanent-error-messages';
import type { PermanentPlacementView } from './permanent-placement-types';

// Track 7 / T7-P5 §5.4 — record a qualifying falloff. Calendar DATE input (an `<input type="date">`
// whose value is a bare yyyy-mm-dd — no timezone conversion) + a CLOSED RadioGroup of the governed
// falloff reasons (no OTHER, no free text). On success the parent re-reads server truth (the
// deterministic remedy-due state); out-of-window date / ungoverned reason are governed 422s
// rendered as actionable copy. Mounted only while the guarantee is active and the actor holds
// placement:permanent:transition.
interface Props {
  readonly open: boolean;
  readonly placementId: string;
  readonly onClose: () => void;
  readonly onRecorded: () => void;
  readonly recordFalloffFn?: (
    id: string,
    body: { effective_date: string; reason: string },
  ) => Promise<PermanentPlacementView>;
}

const REASON_OPTIONS: ReadonlyArray<RadioOption<FalloffReasonCode>> = FALLOFF_REASON_CODES.map((value) => ({
  value,
  label: FALLOFF_REASON_LABELS[value],
}));

export function RecordFalloffDialog({ open, placementId, onClose, onRecorded, recordFalloffFn }: Props) {
  const recordFun = recordFalloffFn ?? recordFalloff;
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reason, setReason] = useState<FalloffReasonCode>('TALENT_RESIGNED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setEffectiveDate('');
    setReason('TALENT_RESIGNED');
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    if (effectiveDate === '') {
      setError('Choose the falloff effective date.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await recordFun(placementId, { effective_date: effectiveDate, reason });
      toast.show('Falloff recorded.');
      reset();
      onRecorded();
      onClose();
    } catch (err) {
      setError(falloffErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Record a falloff"
      description="Record a qualifying falloff within the guarantee window. This lands the deterministic remedy obligation."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="falloff-record-confirm">
            {busy ? 'Recording…' : 'Record falloff'}
          </Button>
        </>
      }
    >
      <FormField label="Effective date">
        <input
          className="rc-input"
          type="date"
          aria-label="Falloff effective date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
          disabled={busy}
          data-testid="falloff-date-input"
        />
      </FormField>
      <fieldset className="rc-field">
        <legend className="rc-field__label">Reason</legend>
        <RadioGroup
          name="falloff-reason"
          value={reason}
          options={REASON_OPTIONS}
          onValueChange={setReason}
          disabled={busy}
        />
      </fieldset>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
