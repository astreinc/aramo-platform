import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogClose,
  FormField,
  InlineAlert,
} from '@aramo/fe-foundation';

import { revokeErrorMessage } from './error-messages';
import { revokeSubmittal } from './submittals-api';
import type { TalentSubmittalRecordView } from './types';

interface RevokeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly submittal: TalentSubmittalRecordView;
  readonly idempotencyKey: string;
  readonly onRevoked: (next: TalentSubmittalRecordView) => void;
}

// RevokeDialog — the revoke-from-any-non-terminal action. Always-available
// affordance on non-terminal wizard states (the host renders the trigger
// button under canRevoke). The revocation_justification is required by
// the backend; we trim + reject empty.
export function RevokeDialog({
  open,
  onOpenChange,
  submittal,
  idempotencyKey,
  onRevoked,
}: RevokeDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await revokeSubmittal(submittal.id, trimmed, idempotencyKey);
      onRevoked(res.submittal);
      onOpenChange(false);
    } catch (err) {
      setError(revokeErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Revoke submittal"
      description="Revoking is permanent. The evidence package is preserved; only the workflow record is closed."
      size="sm"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <DialogClose asChild>
            <Button variant="ghost" type="button">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? 'Revoking…' : 'Revoke submittal'}
          </Button>
        </div>
      }
    >
      <FormField label="Revocation reason">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          required
          aria-required="true"
        />
      </FormField>
      {error !== null && (
        <div style={{ marginTop: '0.5rem' }}>
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      )}
    </Dialog>
  );
}
