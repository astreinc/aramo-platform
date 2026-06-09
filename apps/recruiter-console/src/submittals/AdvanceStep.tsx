import { useState } from 'react';
import { Button, Card, InlineAlert } from '@aramo/fe-foundation';

import { transitionErrorMessage } from './error-messages';
import {
  confirmAts,
  markReady,
  submitToAts,
} from './submittals-api';
import { nextMainlineState } from './submittal-state';
import {
  SUBMITTAL_STATE_LABELS,
  type SubmittalStateValue,
  type TalentSubmittalRecordView,
} from './types';

interface AdvanceStepProps {
  readonly submittal: TalentSubmittalRecordView;
  readonly idempotencyKey: string;
  readonly onAdvanced: (next: TalentSubmittalRecordView) => void;
}

// AdvanceStep — the three plain-button mainline transitions:
//   handoff_draft -> ready_for_review  via /mark-ready
//   ready_for_review -> submitted_to_ats  via /submit-to-ats
//   submitted_to_ats -> confirmed  via /confirm-ats  (terminal)
//
// The other two states are handled outside this component:
//   created -> handoff_draft  via /confirm + attestations  (ConfirmStep)
//   confirmed / revoked  are terminal; the host renders read-only views.
//
// Each transition fires under the wizard's per-action Idempotency-Key
// (UUIDv4 minted once; reused on retry of the same body).
export function AdvanceStep({
  submittal,
  idempotencyKey,
  onAdvanced,
}: AdvanceStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = nextMainlineState(submittal.state);

  const action = (() => {
    switch (submittal.state) {
      case 'handoff_draft':
        return {
          label: 'Mark ready for review',
          run: () => markReady(submittal.id, idempotencyKey),
        };
      case 'ready_for_review':
        return {
          label: 'Submit to ATS',
          run: () => submitToAts(submittal.id, idempotencyKey),
        };
      case 'submitted_to_ats':
        return {
          label: 'Confirm ATS receipt',
          run: () => confirmAts(submittal.id, idempotencyKey),
        };
      case 'created':
      case 'confirmed':
      case 'revoked':
        return null;
    }
  })();

  if (action === null || next === null) {
    return null;
  }

  const handleClick = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await action.run();
      onAdvanced(res.submittal);
    } catch (err) {
      setError(transitionErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      title={SUBMITTAL_STATE_LABELS[submittal.state]}
      description={`Advance to ${SUBMITTAL_STATE_LABELS[next as SubmittalStateValue]}`}
    >
      {error !== null && (
        <div style={{ marginBottom: '1rem' }}>
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      )}
      <Button onClick={handleClick} disabled={submitting}>
        {submitting ? 'Advancing…' : action.label}
      </Button>
    </Card>
  );
}
