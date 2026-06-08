import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InlineAlert, PageHeader } from '@aramo/fe-foundation';

import {
  ResumeUploadSection,
  type ResumeUploadState,
} from './ResumeUploadSection';
import { TalentForm } from './TalentForm';
import { createAttachment, createTalent } from './talent-api';
import { attachErrorMessage, createErrorMessage } from './error-messages';
import type {
  CreateTalentRecordRequest,
  TalentRecordPrefill,
  TalentRecordView,
} from './types';

// R5 — the talent CREATE route wrapper (the intake side).
//
// Ruling 1: single form with an optional in-place résumé-prefill at
// the top (NOT a 2-screen wizard).
// Ruling 3: the résumé attaches on submit in ALL parse_status branches
// (parsed / partial / failed) — even a failed parse preserves the
// uploaded file on the talent record (a human can read what the parser
// couldn't).
//
// The orchestration:
//   1. POST /v1/talent-records → returns TalentRecordView with id
//   2. If a résumé was uploaded (storage_key present in any branch):
//      POST /v1/attachments with is_resume=true, owner_type='talent'.
//      The BE auto-clears the orphan-pending tag (markResumeCommitted).
//   3. Navigate to /talent/:id (the R3 DETAIL).
//
// Attach-failure semantics: the talent IS created; the attach is a
// soft-fail (a friendly message; the recruiter can re-attach later
// from the DETAIL). We do NOT roll back the talent on attach failure.

export function TalentCreateView() {
  const navigate = useNavigate();
  const [resume, setResume] = useState<ResumeUploadState>({ status: 'idle' });
  const [prefill, setPrefill] = useState<TalentRecordPrefill | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attachWarning, setAttachWarning] = useState<string | null>(null);

  async function onSubmit(body: CreateTalentRecordRequest): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    setAttachWarning(null);
    let created: TalentRecordView;
    try {
      created = await createTalent(body);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
      return;
    }

    // Ruling 3: attach in ALL three parse_status branches (parsed /
    // partial / failed). Also attach when status='error' as long as
    // storage_key is set (the upload succeeded; only the parse
    // network failed).
    const shouldAttach =
      resume.file !== undefined && resume.storage_key !== undefined;
    if (shouldAttach && resume.file !== undefined && resume.storage_key !== undefined) {
      try {
        await createAttachment({
          owner_type: 'talent',
          owner_id: created.id,
          file_name: resume.file.name,
          mime: resume.file.type === '' ? 'application/octet-stream' : resume.file.type,
          size_bytes: resume.file.size,
          storage_key: resume.storage_key,
          is_resume: true,
        });
      } catch (err) {
        // Soft-fail: the talent IS created; surface the attach problem
        // but still navigate to the detail (the recruiter can re-attach
        // later from the DETAIL page).
        setAttachWarning(attachErrorMessage(err));
        // Brief pause so the warning is visible before navigation? No —
        // the warning lives on the detail-page side via a toast in a
        // future iteration; for now, navigate and the recruiter notices
        // the missing résumé on the DETAIL attachments tab.
      }
    }
    navigate(`/talent/${created.id}`);
  }

  function onCancel(): void {
    navigate('/talent');
  }

  return (
    <section>
      <PageHeader
        title="New talent"
        description="Add a person to your tenant talent pool. You can upload a résumé to prefill the form."
      />
      <p className="talent-form__note">
        Talent you create enters the shared tenant pool — visible to all
        recruiters in your site. You'll review and complete any prefilled
        fields before saving.
      </p>
      <ResumeUploadSection
        value={resume}
        onChange={setResume}
        onPrefill={setPrefill}
        disabled={submitting}
      />
      {attachWarning !== null ? (
        <InlineAlert variant="error">{attachWarning}</InlineAlert>
      ) : null}
      <TalentForm
        mode="create"
        prefill={prefill}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        submitError={submitError}
      />
    </section>
  );
}
