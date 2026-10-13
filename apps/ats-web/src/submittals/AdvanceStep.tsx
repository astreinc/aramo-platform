import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ApiError, Button, Card, InlineAlert, Select, hasScope, useSession } from '@aramo/fe-foundation';

import { AttestCheckbox } from '../ui';
import { EngagementOverridePrompt } from '../engagement/EngagementOverridePrompt';
import { getEngagementReadiness, type EngagementReadiness } from '../engagement/engagement-api';

import { transitionErrorMessage } from './error-messages';
import {
  confirmAts,
  markReady,
  submitToClient,
} from './submittals-api';
import { nextMainlineState } from './submittal-state';
import {
  SUBMITTAL_STATE_LABELS,
  type SubmittalStateValue,
  type TalentSubmittalRecordView,
} from './types';

// INC-1d — the manual delivery channels the send accepts (aramo_connector is NOT
// offered: V1 has no outbound connector). Kept local to the wizard step so it does
// not couple to the Submittal Workspace module.
const WIZARD_DELIVERY_CHANNELS = [
  'manual_vms',
  'manual_client_portal',
  'manual_email',
  'manual_other',
] as const;
type WizardDeliveryChannel = (typeof WIZARD_DELIVERY_CHANNELS)[number];
const WIZARD_DELIVERY_LABELS: Record<WizardDeliveryChannel, string> = {
  manual_vms: 'Client VMS (manual)',
  manual_client_portal: 'Client portal (manual)',
  manual_email: 'Email (manual)',
  manual_other: 'Other (manual)',
};

interface AdvanceStepProps {
  readonly submittal: TalentSubmittalRecordView;
  readonly idempotencyKey: string;
  readonly onAdvanced: (next: TalentSubmittalRecordView) => void;
}

// AdvanceStep — the three plain-button mainline transitions:
//   handoff_draft -> ready_for_review  via /mark-ready
//   ready_for_review -> submitted_to_client  via /submit-to-client
//   submitted_to_client -> confirmed  via /confirm-ats  (terminal)
//
// COMM PART A (A9) — when the client-handoff send is blocked by an
// ENFORCING_WITH_OVERRIDE engagement policy
// (CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE), the readiness is
// loaded to decide whether an override is available. If the session holds
// `engagement:policy:override`, the SAME EngagementOverridePrompt is surfaced in
// this (the only) submit flow; the override re-runs `submitToClient` with a recorded
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
  // INC-1d — the send step (ready_for_review -> submitted_to_client) collects the
  // manual delivery channel + the mandatory handoff attestation; both are required
  // by the server on the submit-to-client send.
  const [method, setMethod] = useState<WizardDeliveryChannel>('manual_vms');
  const [handoffPerformed, setHandoffPerformed] = useState(false);

  const sessionState = useSession();
  const canOverride =
    sessionState.status === 'authenticated' && hasScope(sessionState.session, 'engagement:policy:override');

  const next = nextMainlineState(submittal.state);
  const isSend = submittal.state === 'ready_for_review';
  // INC-1d — the provenance the send (and any override re-send) must carry.
  const handoffProvenance = { handoff_performed: true as const, delivery_channel: method };

  const action = (() => {
    switch (submittal.state) {
      case 'handoff_draft':
        return {
          label: 'Mark ready for review',
          run: () => markReady(submittal.id, idempotencyKey),
        };
      case 'ready_for_review':
        return {
          label: 'Record client handoff',
          run: () => submitToClient(submittal.id, handoffProvenance, idempotencyKey),
        };
      case 'submitted_to_client':
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

  // On an engagement block from the client-handoff send, load readiness so the override
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
    // INC-1d — never fire an unattested send; the server would fail closed anyway.
    if (isSend && !handoffPerformed) {
      setError('Please confirm you performed this handoff before submitting.');
      return;
    }
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
      // INC-1d — the override re-send still carries the mandatory handoff provenance.
      const res = await submitToClient(submittal.id, handoffProvenance, uuidv4(), { reason });
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
      {isSend && (
        <div style={{ marginBottom: '1rem' }} data-testid="advance-handoff-provenance">
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>How was it delivered?</span>
            <Select
              unstyled
              className="rc-input"
              value={method}
              onChange={(e) => setMethod(e.target.value as WizardDeliveryChannel)}
              aria-label="Delivery channel"
            >
              {WIZARD_DELIVERY_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {WIZARD_DELIVERY_LABELS[c]}
                </option>
              ))}
            </Select>
          </label>
          <AttestCheckbox checked={handoffPerformed} onChange={setHandoffPerformed}>
            I confirm I performed this handoff to the client.
          </AttestCheckbox>
          <p style={{ marginTop: '0.5rem', opacity: 0.8 }}>
            Aramo records your attestation that this handoff happened; it does not send
            anything to the client and does not confirm the client received it.
          </p>
        </div>
      )}
      <Button onClick={handleClick} disabled={submitting || (isSend && !handoffPerformed)}>
        {submitting ? 'Advancing…' : action.label}
      </Button>
    </Card>
  );
}
