import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ApiError, Button, Card, InlineAlert, hasScope, useSession } from '@aramo/fe-foundation';

import { EngagementOverridePrompt } from '../engagement/EngagementOverridePrompt';
import { getEngagementReadiness, type EngagementReadiness } from '../engagement/engagement-api';

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
// COMM PART A (A9) — when Submit to ATS is blocked by an ENFORCING_WITH_OVERRIDE
// engagement policy (CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE), the readiness is
// loaded to decide whether an override is available. If the session holds
// `engagement:policy:override`, the SAME EngagementOverridePrompt is surfaced in
// this (the only) submit flow; the override re-runs `submitToAts` with a recorded
// reason (a fresh Idempotency-Key, since the body changed). Read-error/unavailable
// evidence is fail-closed and non-overridable; a user without the scope never sees
// the override control. No second submit flow, no fabricated evidence.
export function AdvanceStep({
  submittal,
  idempotencyKey,
  onAdvanced,
}: AdvanceStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideReadiness, setOverrideReadiness] = useState<EngagementReadiness | null>(null);

  const sessionState = useSession();
  const canOverride =
    sessionState.status === 'authenticated' && hasScope(sessionState.session, 'engagement:policy:override');

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

  // On an engagement block from Submit to ATS, load readiness so the override
  // affordance can decide availability (mode + missing + unavailable). Best-effort:
  // a readiness-load failure just leaves the plain error message.
  const maybeLoadOverride = async (err: unknown): Promise<void> => {
    if (
      submittal.state === 'ready_for_review' &&
      err instanceof ApiError &&
      err.code === 'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE'
    ) {
      try {
        // submittal.job_id aliases the requisition id (shared-UUID convention).
        const readiness = await getEngagementReadiness(submittal.talent_id, submittal.job_id);
        setOverrideReadiness(readiness);
      } catch {
        /* leave the plain error message */
      }
    }
  };

  const handleClick = async () => {
    if (submitting) return;
    setError(null);
    setOverrideReadiness(null);
    setSubmitting(true);
    try {
      const res = await action.run();
      onAdvanced(res.submittal);
    } catch (err) {
      setError(transitionErrorMessage(err));
      await maybeLoadOverride(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleOverride = async (reason: string) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Fresh Idempotency-Key: the body now carries the override (changed body).
      const res = await submitToAts(submittal.id, uuidv4(), { reason });
      setOverrideReadiness(null);
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
      {overrideReadiness !== null && (
        <div style={{ marginBottom: '1rem' }} data-testid="advance-engagement-override">
          <EngagementOverridePrompt
            readiness={overrideReadiness}
            canOverride={canOverride}
            onOverride={handleOverride}
            busy={submitting}
          />
        </div>
      )}
      <Button onClick={handleClick} disabled={submitting}>
        {submitting ? 'Advancing…' : action.label}
      </Button>
    </Card>
  );
}
