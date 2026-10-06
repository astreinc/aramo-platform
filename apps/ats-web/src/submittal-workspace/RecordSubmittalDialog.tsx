import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ApiError, DialogClose, Input } from '@aramo/fe-foundation';

import { Button, Dialog, InlineAlert, RadioGroup, safeErrorMessage } from '../ui';
import { submitToClient } from '../submittals/submittals-api';

import { deliveryLabel } from './present';
import { V1_MANUAL_DELIVERY_CHANNELS, type V1ManualDeliveryChannel } from './submittal-workspace-types';

interface RecordSubmittalDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly submittalId: string;
  readonly who: string;
  readonly role: string | null;
  readonly client: string | null;
  /** Read-only recap facts — rendered only when the server provided them. */
  readonly resumeLabel: string | null;
  readonly billRateLabel: string | null;
  /** Success: the submittal is now submitted_to_client. The page refetches. */
  readonly onRecorded: () => void;
  /** The authoritative slot was consumed by another submittal between read and
   *  write. The page surfaces the race banner and refetches — never optimistic. */
  readonly onRaceConflict: () => void;
}

const METHOD_OPTIONS = V1_MANUAL_DELIVERY_CHANNELS.map((v) => ({
  value: v,
  label: deliveryLabel(v),
}));

function localNowValue(): string {
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// SW-5 — Record submittal. This records a client handoff that happened OUTSIDE
// Aramo (manual VMS / client portal / email / other). The copy and the "Record"
// verb deliberately never imply Aramo transmitted anything (no outbound connector
// exists; aramo_connector is not offered). The authoritative result is
// submitted_to_client + frozen provenance — written by the server, never faked here.
export function RecordSubmittalDialog({
  open,
  onOpenChange,
  submittalId,
  who,
  role,
  client,
  resumeLabel,
  billRateLabel,
  onRecorded,
  onRaceConflict,
}: RecordSubmittalDialogProps) {
  const [method, setMethod] = useState<V1ManualDeliveryChannel>('manual_vms');
  const [externalRef, setExternalRef] = useState('');
  const [submittedAt, setSubmittedAt] = useState(localNowValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtitleParts = [who, role, client].filter((p): p is string => !!p);

  const handleRecord = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const external_submitted_at = submittedAt.trim().length > 0
        ? new Date(submittedAt).toISOString()
        : undefined;
      const external_reference = externalRef.trim().length > 0 ? externalRef.trim() : undefined;
      await submitToClient(
        submittalId,
        { delivery_channel: method, external_reference, external_submitted_at },
        uuidv4(),
      );
      onOpenChange(false);
      onRecorded();
    } catch (err) {
      // The slot race: readiness was READY at read, but the last slot was consumed
      // before this write. Hand off to the page's authoritative refresh path.
      if (err instanceof ApiError && err.code === 'SUBMITTAL_LIMIT_REACHED') {
        onOpenChange(false);
        onRaceConflict();
        return;
      }
      setError(safeErrorMessage(err, 'Couldn’t record the submittal. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record client submittal"
      description={subtitleParts.join(' · ')}
      size="md"
      footer={
        <div className="sw-modal__footer">
          <DialogClose asChild>
            <Button variant="ghost" type="button">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleRecord} disabled={submitting}>
            {submitting ? 'Recording…' : 'Record submittal'}
          </Button>
        </div>
      }
    >
      <div className="sw-modal__recap">
        <span>
          <span className="sw-modal__recap-k">RESUME</span>
          <b>{resumeLabel ?? 'Selected resume'}</b>
        </span>
        {billRateLabel !== null ? (
          <span>
            <span className="sw-modal__recap-k">CLIENT RATE</span>
            <b>{billRateLabel}</b>
          </span>
        ) : null}
      </div>

      <div className="sw-modal__section-label">How was it delivered?</div>
      <RadioGroup
        name="sw-delivery-method"
        value={method}
        options={METHOD_OPTIONS}
        onValueChange={(v) => setMethod(v)}
      />

      <div className="sw-modal__fields">
        <label className="sw-field">
          <span className="sw-field__label">
            External reference <span className="sw-field__opt">· optional</span>
          </span>
          <Input
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            placeholder="e.g. FG-938273"
          />
        </label>
        <label className="sw-field">
          <span className="sw-field__label">Submitted at</span>
          <Input
            type="datetime-local"
            value={submittedAt}
            onChange={(e) => setSubmittedAt(e.target.value)}
          />
        </label>
      </div>

      <p className="sw-modal__note">
        Aramo records this handoff; it does not send anything to the client. The
        resume and client rate above are frozen once recorded.
      </p>

      {error !== null ? (
        <div className="sw-modal__error">
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      ) : null}
    </Dialog>
  );
}
