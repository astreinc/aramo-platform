import { useState } from 'react';
import { Button, Card, FormField, InlineAlert } from '@aramo/fe-foundation';

import { confirmErrorMessage } from './error-messages';
import { confirmSubmittal } from './submittals-api';
import type { TalentSubmittalRecordView } from './types';

interface ConfirmStepProps {
  readonly submittal: TalentSubmittalRecordView;
  readonly idempotencyKey: string;
  readonly onConfirmed: (next: TalentSubmittalRecordView) => void;
}

// ConfirmStep — the attestation-gated `created → handoff_draft`
// transition via POST /v1/submittals/:id/confirm.
//
// Per the BE controller (libs/submittal/src/lib/submittal.controller.ts
// lines 307-326), all three attestations MUST be literal-true; the
// backend manually checks and throws ATTESTATION_MISSING 422 if any is
// missing. The wizard START-UNCHECKED (the recruiter affirmatively
// checks each before the Confirm button enables) per the directive's
// "literal-true, START unchecked" mandate.
export function ConfirmStep({
  submittal,
  idempotencyKey,
  onConfirmed,
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
    <Card
      title="Confirm submittal"
      description="Affirm the three attestations before advancing the submittal to handoff draft."
    >
      <FormField label="Attestations">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <label>
            <input
              type="checkbox"
              checked={talentEvidence}
              onChange={(e) => setTalentEvidence(e.target.checked)}
            />{' '}
            I have reviewed the talent’s evidence.
          </label>
          <label>
            <input
              type="checkbox"
              checked={constraints}
              onChange={(e) => setConstraints(e.target.checked)}
            />{' '}
            I have reviewed the constraints.
          </label>
          <label>
            <input
              type="checkbox"
              checked={risk}
              onChange={(e) => setRisk(e.target.checked)}
            />{' '}
            I acknowledge the submittal risk.
          </label>
        </div>
      </FormField>
      {error !== null && (
        <div style={{ marginTop: '1rem' }}>
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      )}
      <div style={{ marginTop: '1rem' }}>
        <Button onClick={handleClick} disabled={!allChecked || submitting}>
          {submitting ? 'Confirming…' : 'Confirm submittal'}
        </Button>
      </div>
    </Card>
  );
}
