import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Icons, InlineAlert, PageHeader } from '../ui';

import { IntakeForm } from './IntakeForm';
import { getTalent, getTalentWorkHistory, updateTalent } from './talent-api';
import { detailErrorMessage, updateErrorMessage } from './error-messages';
import {
  buildPatchBody,
  emptyIntakeState,
  stateFromTalent,
  type IntakeState,
} from './intake-fields';
import type { TalentRecordView, WorkHistoryDraft, WorkHistoryView } from './types';

// R5 — the talent full-profile EDIT. Reuses the Add-Talent Step-2 layout
// (IntakeForm), pre-filled from the stored record; saves via PATCH (true PATCH,
// R4 omit-vs-null) → back to the detail.
//
// Quick-Edit rules apply to the full edit (PO ruling):
//   • Email + phone are the identity/dedup anchors (email is required + the
//     primary key; email+phone together identify a talent) → DISPLAY-ONLY here.
//   • Every other field — including key_skills AND work-history — is editable:
//     a returning talent's skills + work history may have changed.
//
// Work-history edit is REPLACE-SET: the reviewed set becomes the talent's
// declared work history (BE replaces the prior 'resume'-sourced rows). Sent only
// when the recruiter touched the work-history section (else left untouched).
//
// NO resume upload in EDIT — replacing a resume is a separate later feature.

const LOCKED_FIELDS = new Set<keyof IntakeState>(['email1', 'phone_cell']);

function draftFromView(v: WorkHistoryView): WorkHistoryDraft {
  return {
    employer_name: v.employer_name,
    role_title: v.role_title,
    ...(v.start_date !== null ? { start_date: v.start_date } : {}),
    ...(v.end_date !== null ? { end_date: v.end_date } : {}),
    ...(v.employment_type !== null ? { employment_type: v.employment_type } : {}),
    ...(v.description !== null ? { description: v.description } : {}),
  };
}

export function TalentEditView() {
  const { talentId } = useParams<{ talentId: string }>();
  const navigate = useNavigate();

  const [talent, setTalent] = useState<TalentRecordView | null>(null);
  const [fields, setFields] = useState<IntakeState>(emptyIntakeState);
  const [workHistory, setWorkHistory] = useState<WorkHistoryDraft[]>([]);
  // Replace-set is applied ONLY when the recruiter touches the work-history
  // section — otherwise the PATCH omits work_history and the BE leaves it alone.
  const [workHistoryDirty, setWorkHistoryDirty] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (talentId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getTalent(talentId), getTalentWorkHistory(talentId).catch(() => ({ work_history: [] }))])
      .then(([record, wh]) => {
        if (cancelled) return;
        setTalent(record);
        setFields(stateFromTalent(record));
        setWorkHistory(wh.work_history.map(draftFromView));
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

  function onField(key: keyof IntakeState, value: string): void {
    setFields((s) => ({ ...s, [key]: value }));
  }
  function onToggle(key: 'can_relocate' | 'is_hot'): void {
    setFields((s) => ({ ...s, [key]: !s[key] }));
  }
  function onWorkHistoryField(index: number, key: keyof WorkHistoryDraft, value: string): void {
    setWorkHistoryDirty(true);
    setWorkHistory((prev) => prev.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
  }
  function onAddWorkHistory(): void {
    setWorkHistoryDirty(true);
    setWorkHistory((prev) => [...prev, { employer_name: '', role_title: '' }]);
  }
  function onRemoveWorkHistory(index: number): void {
    setWorkHistoryDirty(true);
    setWorkHistory((prev) => prev.filter((_, i) => i !== index));
  }

  if (talentId === undefined) {
    return <InlineAlert variant="error">Missing talent id in URL.</InlineAlert>;
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

  const nameOk = fields.first_name.trim() !== '' && fields.last_name.trim() !== '';
  const canSave = nameOk && !submitting;

  async function onSave(): Promise<void> {
    if (talent === null || !canSave) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = buildPatchBody(fields, talent, workHistoryDirty ? workHistory : undefined);
      const updated = await updateTalent(talent.id, body);
      navigate(`/talent/${updated.id}`);
    } catch (err) {
      setSubmitError(updateErrorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <section className="rc-addtalent">
      <PageHeader
        title={`Edit: ${talent.first_name} ${talent.last_name}`}
        description="Update the profile. Email and phone identify this talent and can't be changed here."
      />

      {submitError !== null ? <InlineAlert variant="error">{submitError}</InlineAlert> : null}

      <IntakeForm
        values={fields}
        provenance={{}}
        workHistory={workHistory}
        disabled={submitting}
        lockedFields={LOCKED_FIELDS}
        onField={onField}
        onToggle={onToggle}
        onWorkHistoryField={onWorkHistoryField}
        onAddWorkHistory={onAddWorkHistory}
        onRemoveWorkHistory={onRemoveWorkHistory}
      />

      <div className="rc-addfoot">
        <div className="rc-addfoot__actions">
          <button
            type="button"
            className="rc-btn rc-btn--primary"
            disabled={!canSave}
            onClick={() => void onSave()}
          >
            <Icons.IconCheck />
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            className="rc-btn"
            disabled={submitting}
            onClick={() => navigate(`/talent/${talent.id}`)}
          >
            Cancel
          </button>
        </div>
        <p className="rc-addfoot__note">
          Email and phone are identity anchors and are managed separately · provenance is recorded automatically.
        </p>
      </div>
    </section>
  );
}
