import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Icons, InlineAlert, PageHeader } from '../ui';

import { IntakeForm } from './IntakeForm';
import { ResumePreview } from './ResumePreview';
import {
  confirmTalentResumeEdition,
  createAttachment,
  createTalentResumeEdition,
  getAttachmentDownloadUrl,
  getTalent,
  getTalentWorkHistory,
  listTalentResumeEditions,
  putResumeToStorage,
  rejectTalentResumeEdition,
  requestResumeUploadUrl,
  setTalentResumeEditionDefault,
  updateTalent,
} from './talent-api';
import { detailErrorMessage, updateErrorMessage } from './error-messages';
import {
  buildPatchBody,
  emptyIntakeState,
  stateFromTalent,
  type IntakeState,
} from './intake-fields';
import type {
  TalentRecordView,
  TalentResumeEditionView,
  WorkHistoryDraft,
  WorkHistoryView,
} from './types';

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
// Résumé: the full edit shows the stored résumé in a preview pane (Create-style
// layout) and supports REPLACE (upload a new résumé → new attachment, is_resume;
// the prior version stays in Documents). Same upload pipeline as Add-Talent.

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

      {/* Same two-column layout as Add-Talent: form on the left, résumé preview
          (+ replace) on the right so the recruiter validates against the source. */}
      <div className="rc-editgrid">
        <div className="rc-editgrid__main">
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
        </div>
        <aside className="rc-editgrid__rail">
          <EditResumePanel talentId={talent.id} disabled={submitting} />
        </aside>
      </div>

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

// Résumé preview + Replace for the full edit. Shows the stored résumé (presigned
// GET) and — mirroring the quick-edit drawer — lets the recruiter REPLACE it:
// upload a new file (same pipeline as Add-Talent) → a new is_resume attachment
// (the prior version stays in Documents). Replace is applied immediately (not
// gated on "Save changes"); the newly-uploaded file previews from memory.
// TALENT-INTEL-1 TI-1D-C — the panel now consumes the RÉSUMÉ EDITION collection
// (no more resumes[length-1] latest-wins). A talent may hold multiple
// simultaneously-valid editions; the recruiter EXPLICITLY selects which to view
// and which is the default. Selecting/defaulting is PRESENTATION only — it never
// changes the talent PATCH provenance and does not make an edition "talent truth".
// Uploading a new résumé registers a NEW edition (attachment → edition); it does
// NOT replace prior editions.
// TALENT-INTEL-1 TI-1F-C §4-L — the recruiter-facing label for the governed
// résumé-extraction lifecycle projected onto the edition. Worker attempt-counts /
// error internals never reach the recruiter (§4-K); only these coarse states do.
function resumeReviewLabel(status: string | null): string | null {
  switch (status) {
    case 'PROCESSING':
      return 'Processing…';
    case 'READY_FOR_REVIEW':
      return 'Ready — review';
    case 'FAILED':
      return 'Processing failed';
    case 'ACCEPTED':
      return 'Reviewed ✓';
    case 'REJECTED':
      return 'Rejected';
    default:
      return null;
  }
}

function EditResumePanel({
  talentId,
  disabled,
}: {
  readonly talentId: string;
  readonly disabled: boolean;
}) {
  const [editions, setEditions] = useState<readonly TalentResumeEditionView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replacedFile, setReplacedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // TALENT-INTEL-1 TI-1F-C — the per-edition review action in flight (the edition
  // whose CONFIRM/REJECT is running) so the buttons disable + no double-submit.
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const loadEditions = (): Promise<void> =>
    listTalentResumeEditions(talentId)
      .then((res) => {
        const list = res.editions ?? [];
        setEditions(list);
        // Default the SELECTION to the explicit default edition (never "newest").
        const def = list.find((e) => e.is_default) ?? list[0];
        setSelectedId((prev) => prev ?? def?.edition_id ?? null);
      })
      .catch(() => {
        /* best-effort — an empty collection just shows the attach affordance */
      });

  // TI-1F-C §4-L — the human-governed review. CONFIRM promotes the reviewed draft
  // to typed evidence (server-side reconcile signals fire); REJECT discards it. On
  // success we re-fetch the editions so the recruiter sees the new
  // processing_status. Hydration is composed on-read, so the next profile view
  // reflects the promoted truth (no client cache to invalidate here).
  const onConfirm = (editionId: string): void => {
    setReviewingId(editionId);
    confirmTalentResumeEdition(talentId, editionId)
      .then(() => loadEditions())
      .catch(() => undefined)
      .finally(() => setReviewingId(null));
  };
  const onReject = (editionId: string): void => {
    setReviewingId(editionId);
    rejectTalentResumeEdition(talentId, editionId)
      .then(() => loadEditions())
      .catch(() => undefined)
      .finally(() => setReviewingId(null));
  };

  useEffect(() => {
    let cancelled = false;
    void loadEditions().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  const selected = editions.find((e) => e.edition_id === selectedId) ?? null;

  // Preview the SELECTED edition (via its backing attachment, if any). Best-effort.
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    if (selected === null || selected.attachment_id === null) return undefined;
    getAttachmentDownloadUrl(selected.attachment_id)
      .then((r) => {
        if (!cancelled) setPreviewUrl(r.presigned_url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const onReplace = (file: File | undefined): void => {
    if (file === undefined) return;
    setStatus('uploading');
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    requestResumeUploadUrl({ filename: file.name, content_type: contentType })
      .then((presign) =>
        putResumeToStorage(presign.presigned_url, file, contentType).then(() =>
          createAttachment({
            owner_type: 'talent',
            owner_id: talentId,
            file_name: file.name,
            mime: contentType,
            size_bytes: file.size,
            storage_key: presign.storage_key,
            is_resume: true,
          }),
        ),
      )
      // Register the uploaded attachment as a NEW résumé edition (not a
      // destructive replace — prior editions remain valid).
      .then((att) => createTalentResumeEdition(talentId, { attachment_id: att.id }))
      .then((edition) => {
        setReplacedFile(file);
        setStatus('done');
        setSelectedId(edition.edition_id);
        return loadEditions();
      })
      .catch(() => setStatus('error'));
  };

  const onMakeDefault = (editionId: string): void => {
    setTalentResumeEditionDefault(talentId, editionId)
      .then((res) => setEditions(res.editions))
      .catch(() => undefined);
  };

  const action = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.doc,.docx,application/pdf"
        hidden
        onChange={(e) => onReplace(e.target.files?.[0])}
      />
      {status === 'done' ? <span className="rc-secnote">Added ✓</span> : null}
      {status === 'error' ? <span className="rc-secnote">Upload failed</span> : null}
      <button
        type="button"
        className="rc-rpreview__expand"
        disabled={disabled || status === 'uploading'}
        onClick={() => inputRef.current?.click()}
      >
        {status === 'uploading' ? 'Uploading…' : 'Add résumé'}
      </button>
    </>
  );

  // The edition chooser — explicit selection + default, presentation-only.
  const chooser =
    editions.length === 0 ? null : (
      <ul className="rc-redition-list" aria-label="Résumé editions">
        {editions.map((e) => (
          <li key={e.edition_id} className="rc-redition">
            <button
              type="button"
              className="rc-redition__pick"
              aria-pressed={e.edition_id === selectedId}
              onClick={() => setSelectedId(e.edition_id)}
            >
              {e.filename}
              {e.label !== null ? ` — ${e.label}` : ''}
            </button>
            {e.is_default ? (
              <span className="rc-secnote rc-redition__default">Default</span>
            ) : (
              <button
                type="button"
                className="rc-redition__setdefault"
                disabled={disabled}
                onClick={() => onMakeDefault(e.edition_id)}
              >
                Make default
              </button>
            )}
            {/* TI-1F-C §4-L — the governed-extraction lifecycle + review action. */}
            {resumeReviewLabel(e.processing_status) !== null ? (
              <span className="rc-secnote rc-redition__status">
                {resumeReviewLabel(e.processing_status)}
              </span>
            ) : null}
            {e.processing_status === 'READY_FOR_REVIEW' ? (
              <>
                <button
                  type="button"
                  className="rc-redition__confirm"
                  disabled={disabled || reviewingId === e.edition_id}
                  onClick={() => onConfirm(e.edition_id)}
                >
                  {reviewingId === e.edition_id ? 'Confirming…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="rc-redition__reject"
                  disabled={disabled || reviewingId === e.edition_id}
                  onClick={() => onReject(e.edition_id)}
                >
                  Reject
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    );

  if (replacedFile !== null && selected === null) {
    return (
      <ResumePreview
        file={replacedFile}
        fileName={replacedFile.name}
        mime={replacedFile.type}
        action={action}
      />
    );
  }
  if (selected !== null) {
    return (
      <>
        <ResumePreview
          src={previewUrl}
          fileName={selected.filename}
          mime={selected.mime_type}
          action={action}
        />
        {chooser}
      </>
    );
  }
  // No editions yet — still offer to attach one.
  return (
    <section className="rc-sidecard rc-rpreview" aria-label="Résumé preview">
      <div className="rc-rpreview__hdrow">
        <h3 className="rc-sidecard__h">
          <Icons.IconFile />
          Résumé editions
        </h3>
        <div className="rc-rpreview__hdactions">{action}</div>
      </div>
      <p className="rc-secnote">No résumé editions yet — use Add résumé to attach one.</p>
    </section>
  );
}
