import { Button, InlineAlert } from '@aramo/fe-foundation';
import { useState } from 'react';

import { AttestCheckbox, Card, ReservedSeam } from '../ui';

import { confirmErrorMessage } from './error-messages';
import { confirmSubmittal } from './submittals-api';
import type { TalentSubmittalRecordView } from './types';

interface ConfirmStepProps {
  readonly submittal: TalentSubmittalRecordView;
  readonly idempotencyKey: string;
  readonly onConfirmed: (next: TalentSubmittalRecordView) => void;
  // Resolved by the wizard for the gate header (the submittal carries ids only).
  readonly talentName?: string;
  readonly requisitionTitle?: string;
}

// ConfirmStep — the submittal ATTESTATION GATE (2G). The attestation-gated
// `created → handoff_draft` transition (POST /v1/submittals/:id/confirm). The
// BE requires all three attestations literal-true (ATTESTATION_MISSING 422 if
// any is missing); the gate START-UNCHECKED and the Submit button is DISABLED
// until all three are checked — deliberate friction (DDR §8).
//
// Gap dispositions (DDR §11):
//  - §4: system-computed constraint chips (rate/availability/work-auth/location)
//    are NOT rendered here — those read TalentJobExamination (Core, a later
//    by-product). A ghosted RESERVED seam states the integration instead.
//  - §10: the evidence package endpoint exposes JSONB summaries, NOT a discrete
//    résumé-version / references-count — so the mockup's "v3 · pinned /
//    References (2)" framing is dropped; the gate shows the backed truth (the
//    package + examination are pinned to this submittal). CARRY: discrete
//    résumé-version + references-count.
//
// The three attestation strings are LOCKED copy, reconciled to canonical
// vocab per F2 (talent; "submittal", not the legacy nouns).
export function ConfirmStep({
  submittal,
  idempotencyKey,
  onConfirmed,
  talentName,
  requisitionTitle,
}: ConfirmStepProps) {
  const [talentEvidence, setTalentEvidence] = useState(false);
  const [constraints, setConstraints] = useState(false);
  const [risk, setRisk] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allChecked = talentEvidence && constraints && risk;

  const handleClick = async () => {
    if (!allChecked || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await confirmSubmittal(
        submittal.id,
        {
          talent_evidence_reviewed: talentEvidence,
          constraints_reviewed: constraints,
          submittal_risk_acknowledged: risk,
        },
        idempotencyKey,
      );
      onConfirmed(res.submittal);
    } catch (err) {
      setError(confirmErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rc-gate">
      <div className="rc-gate-head">
        <div className="rc-gate-head__ic" aria-hidden="true">
          <SendIcon />
        </div>
        <div>
          <h1 className="rc-gate-head__h">
            Submit {talentName ?? 'talent'} to client
          </h1>
          {requisitionTitle !== undefined ? (
            <div className="rc-gate-head__s">
              <b>{requisitionTitle}</b>
            </div>
          ) : null}
        </div>
      </div>

      <Card flush className="rc-mt-16">
        {/* §4 — no system-computed constraint chips at this surface. */}
        <div className="rc-gate-block">
          <ReservedSeam
            title="Constraint compliance"
            tag="Integrates with Core later"
          >
            System constraint checks (rate, availability, work authorization,
            location) are evidence-ranked by Aramo Core — they surface here
            later. The attestations below are your gate today.
          </ReservedSeam>
        </div>

        <div className="rc-gate-block">
          <h2 className="rc-gate-block__h">Evidence package</h2>
          <div className="rc-gate-doc">
            <DocIcon />
            Evidence package prepared and pinned to this submittal.
          </div>
          <div className="rc-gate-doc">
            <DocIcon />
            Examination pinned <span className="mono">· immutable</span>
          </div>
        </div>

        <div className="rc-gate-block">
          <h2 className="rc-gate-block__h">Your attestation</h2>
          <AttestCheckbox checked={talentEvidence} onChange={setTalentEvidence}>
            I confirm I have communicated directly with this talent and they are
            interested in this role.
          </AttestCheckbox>
          <AttestCheckbox checked={constraints} onChange={setConstraints}>
            I confirm the talent’s rate, availability, and authorization details
            have been validated.
          </AttestCheckbox>
          <AttestCheckbox checked={risk} onChange={setRisk}>
            I confirm this talent is ready for submittal to the client.
          </AttestCheckbox>
          {error !== null ? (
            <InlineAlert variant="error">{error}</InlineAlert>
          ) : null}
        </div>

        <div className="rc-gatefoot">
          <span className="rc-gatefoot__imm">
            <LockIcon />
            Once submitted, the package is locked and cannot be edited.
          </span>
          <Button
            variant="primary"
            type="button"
            onClick={handleClick}
            disabled={!allChecked || submitting}
          >
            {submitting ? 'Submitting…' : 'Submit to client'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
