import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { InlineAlert, PageHeader } from '@aramo/fe-foundation';

import { TalentForm } from './TalentForm';
import { getTalent, updateTalent } from './talent-api';
import { detailErrorMessage, updateErrorMessage } from './error-messages';
import type {
  TalentRecordView,
  UpdateTalentRecordRequest,
} from './types';

// R5 — the talent EDIT route wrapper. Pre-fetches the existing talent
// (the R3 detail's GET), then hands it to TalentForm which builds the
// PATCH body with true PATCH semantics (R4 omit-vs-null).
//
// NO résumé upload in EDIT — replacing a résumé is a separate later
// feature (R5 scopes the résumé to CREATE-side).

export function TalentEditView() {
  const { talentId } = useParams<{ talentId: string }>();
  const navigate = useNavigate();

  const [talent, setTalent] = useState<TalentRecordView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (talentId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTalent(talentId)
      .then((res) => {
        if (cancelled) return;
        setTalent(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  if (talentId === undefined) {
    return (
      <InlineAlert variant="error">Missing talent id in URL.</InlineAlert>
    );
  }
  if (loading) return <p>Loading talent…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Edit talent" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/talent">← Back to talent</Link>
        </p>
      </section>
    );
  }
  if (talent === null) return null;

  async function onSubmit(body: UpdateTalentRecordRequest): Promise<void> {
    if (talent === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await updateTalent(talent.id, body);
      navigate(`/talent/${updated.id}`);
    } catch (err) {
      setSubmitError(updateErrorMessage(err));
      setSubmitting(false);
    }
  }

  function onCancel(): void {
    navigate(`/talent/${talent?.id ?? ''}`);
  }

  return (
    <section>
      <PageHeader
        title={`Edit: ${talent.first_name} ${talent.last_name}`}
        description="Changes apply on save. Leaving a nullable field empty clears it."
      />
      <TalentForm
        mode="edit"
        initial={talent}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        submitError={submitError}
      />
    </section>
  );
}
