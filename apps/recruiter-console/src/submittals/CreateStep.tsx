import { useState } from 'react';
import { Button, Card, FormField, InlineAlert } from '@aramo/fe-foundation';

import { createErrorMessage } from './error-messages';
import { createSubmittal } from './submittals-api';
import type {
  CreateSubmittalRequest,
  MatchListSummary,
  TalentSubmittalRecordView,
} from './types';

interface CreateStepProps {
  readonly talentRecordId: string;
  readonly requisitionId: string;
  readonly examination: MatchListSummary;
  readonly idempotencyKey: string;
  readonly onCreated: (submittal: TalentSubmittalRecordView) => void;
}

// CreateStep — Step 1 of the wizard. Composes the structured create
// payload from a minimal form, then POSTs /v1/submittals with the
// Idempotency-Key minted at wizard mount (reused on retry of the SAME
// body). On success, hands the new submittal back to the wizard host,
// which advances to Step 2.
//
// PHASE-B-CARRY (T1) — see submittals-api.ts for the named-and-anchored
// shared-UUID identity convention. The createSubmittal call passes the
// recruiter-visible requisitionId as `job_id` under that convention.
export function CreateStep({
  talentRecordId,
  requisitionId,
  examination,
  idempotencyKey,
  onCreated,
}: CreateStepProps) {
  const [fullName, setFullName] = useState('');
  const [location, setLocation] = useState('');
  const [recruiterSummary, setRecruiterSummary] = useState('');
  const [contactAvailable, setContactAvailable] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R9 short-circuit: surface the Stretch-block before the create call.
  if (examination.tier === 'STRETCH') {
    return (
      <Card title="Cannot submit (Stretch tier)">
        <InlineAlert variant="error">
          This talent’s examination is Stretch-tier and cannot be
          submitted. Reach out to your manager if you believe this is
          incorrect.
        </InlineAlert>
      </Card>
    );
  }

  const canSubmit =
    fullName.trim().length > 0
    && location.trim().length > 0
    && recruiterSummary.trim().length > 0;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setError(null);
    setSubmitting(true);
    const body: CreateSubmittalRequest = {
      talent_id: talentRecordId,
      // PHASE-B-CARRY (T1) — the de-facto shared-UUID identity convention.
      // The recruiter-visible requisitionId is passed as `job_id` under
      // the assumption that submittal.job_id aliases requisition.id ==
      // examination.job_id. See submittals-api.ts header for the canonical
      // statement of this convention and the LOCKED carry it references.
      job_id: requisitionId,
      examination_id: examination.examination_id,
      talent_identity: {
        full_name: fullName.trim(),
        location: location.trim(),
      },
      contact_summary: {
        contact_available: contactAvailable,
        channels_verified: ['email'],
      },
      capability_summary_overrides: {
        key_work_history: [],
      },
      recruiter_contribution: {
        conversation_summary: { recruiter_summary: recruiterSummary.trim() },
        talent_confirmed: { spoken_to_recruiter: true },
      },
    };
    try {
      const res = await createSubmittal(body, idempotencyKey);
      onCreated(res.submittal);
    } catch (err) {
      setError(createErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      title="Create submittal"
      description="Compose the evidence package the client will receive."
    >
      <form onSubmit={handleSubmit} noValidate>
        <FormField label="Talent full name">
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            aria-required="true"
          />
        </FormField>
        <FormField label="Location">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Remote (US)"
            required
            aria-required="true"
          />
        </FormField>
        <FormField label="Contact available">
          <label>
            <input
              type="checkbox"
              checked={contactAvailable}
              onChange={(e) => setContactAvailable(e.target.checked)}
            />{' '}
            Talent is reachable
          </label>
        </FormField>
        <FormField label="Recruiter conversation summary">
          <textarea
            value={recruiterSummary}
            onChange={(e) => setRecruiterSummary(e.target.value)}
            rows={4}
            required
            aria-required="true"
          />
        </FormField>
        {error !== null && (
          <div style={{ marginTop: '1rem' }}>
            <InlineAlert variant="error">{error}</InlineAlert>
          </div>
        )}
        <div style={{ marginTop: '1rem' }}>
          <Button type="submit" disabled={!canSubmit || submitting}>
            {submitting ? 'Creating…' : 'Create submittal'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
