import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, Button } from '@aramo/fe-foundation';

import { useMe } from '../shell/me-api';
import { Icons, InlineAlert, PageHeader } from '../ui';
import { RecordConsentDialog } from '../consent/RecordConsentDialog';

import { ResumeDropzone } from './ResumeDropzone';
import { ParseProgress } from './ParseProgress';
import { IntakeForm } from './IntakeForm';
import { ResumePreview } from './ResumePreview';
import {
  checkTalentDuplicate,
  putResumeToStorage,
  type TalentDuplicateMatch,
} from './talent-api';
import {
  completeTalentIntakeUpload,
  createTalentIntakeDraft,
  getTalentIntakeDraft,
  openTalentIntakeEvents,
  patchTalentIntakeReview,
  promoteTalentIntakeDraft,
  retryTalentIntakeExtraction,
  type TalentIntakeDraftView,
  type TalentIntakeReviewPayload,
} from './talent-intake-api';
import { createErrorMessage, uploadErrorMessage } from './error-messages';
import { emptyIntakeState, INTAKE_TEXT_KEYS, type IntakeState } from './intake-fields';
import type { Provenance, ProvenanceMap } from './provenance';
import type {
  CertificationDraft,
  EducationDraft,
  TalentRecordView,
  WorkHistoryDraft,
} from './types';

// Durable Async Résumé-First Add-Talent. The browser is NOT part of the
// durability boundary: a résumé upload persists a TalentIntakeDraft; extraction
// runs asynchronously in a worker; the recruiter can leave and return (any
// session/device) via Draft Talents or ?draft=<id>. GET is authoritative; SSE
// is notification-only (triggers a refetch); the Talent is created only on an
// idempotent PROMOTE. The old synchronous draft-from-resume path is retired.
//
// Phases: intake (dropzone) → processing (upload+commit) → form (review, with a
// live processing banner + persisted edits) → success. ?draft restores a
// persisted draft fully from backend state.

type Phase = 'intake' | 'processing' | 'form' | 'success';

const TERMINAL = new Set(['READY', 'PARTIAL', 'FAILED']);

function reviewFieldOrigin(p: Provenance | undefined): 'RESUME_EXTRACTION' | 'RECRUITER' {
  return p === 'governed_llm' ? 'RESUME_EXTRACTION' : 'RECRUITER';
}

function provenanceFromOrigin(origin: string): Provenance {
  return origin === 'RESUME_EXTRACTION' ? 'governed_llm' : 'edited';
}

export function TalentCreateView() {
  const navigate = useNavigate();
  const me = useMe();
  const [searchParams] = useSearchParams();
  const reopenDraftId = searchParams.get('draft');

  const [consentOpen, setConsentOpen] = useState(false);
  const authorName = me?.user.display_name ?? me?.user.email ?? 'you';
  const addedToday = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const headerDescription = `Résumé-first creation · source is recorded automatically ("Added manually by ${authorName} · ${addedToday}")`;

  const [phase, setPhase] = useState<Phase>('intake');

  // Durable draft identity + its persisted lifecycle (GET is authoritative).
  const [draftId, setDraftId] = useState<string | null>(null);
  const [version, setVersion] = useState<number>(0);
  const [processingStatus, setProcessingStatus] = useState<string>('UPLOADED');
  const [reviewStatus, setReviewStatus] = useState<string>('NOT_STARTED');
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);

  // Résumé artifact context. uploadFile is present only on a fresh upload (for
  // the live preview); on reopen we have filename/size from the draft.
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Form state (the review).
  const [fields, setFields] = useState<IntakeState>(emptyIntakeState);
  const [provenance, setProvenance] = useState<ProvenanceMap>({});
  const [workHistory, setWorkHistory] = useState<WorkHistoryDraft[]>([]);
  const [education, setEducation] = useState<readonly EducationDraft[]>([]);
  const [certifications, setCertifications] = useState<readonly CertificationDraft[]>([]);
  // Carried verbatim through PATCH/promote (not recruiter-edited on this form).
  const skillsCarryRef = useRef<unknown[] | undefined>(undefined);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [duplicate, setDuplicate] = useState<TalentDuplicateMatch | null>(null);
  const [created, setCreated] = useState<TalentRecordView | null>(null);

  // Autosave bookkeeping.
  const [reviewDirty, setReviewDirty] = useState(false);
  const versionRef = useRef(version);
  versionRef.current = version;

  const isTerminal = TERMINAL.has(processingStatus);

  // ── review_payload <-> form mapping ─────────────────────────────────────
  const buildReviewPayload = useCallback((): TalentIntakeReviewPayload => {
    const outFields: TalentIntakeReviewPayload['fields'] = {};
    for (const key of INTAKE_TEXT_KEYS) {
      const value = (fields[key] as string).trim();
      const prov = provenance[key as string] as Provenance | undefined;
      // Persist a field when it carries a value OR the recruiter edited it (so an
      // intentional clear is recorded as RECRUITER and extraction won't refill).
      if (value !== '' || prov === 'edited') {
        outFields[key as string] = { value, origin: reviewFieldOrigin(prov) };
      }
    }
    outFields['can_relocate'] = { value: fields.can_relocate, origin: 'RECRUITER' };
    outFields['is_hot'] = { value: fields.is_hot, origin: 'RECRUITER' };
    return {
      fields: outFields,
      work_history: workHistory.filter(
        (e) => e.employer_name.trim() !== '' || e.role_title.trim() !== '',
      ),
      skills: skillsCarryRef.current,
      education: [...education],
      certifications: [...certifications],
    };
  }, [fields, provenance, workHistory, education, certifications]);

  // Hydrate the form from a persisted draft view. preserveEdited keeps local
  // recruiter edits (late extraction must never overwrite a recruiter value).
  const hydrateFromView = useCallback(
    (view: TalentIntakeDraftView, preserveEdited: boolean) => {
      setVersion(view.version);
      setProcessingStatus(view.processing_status);
      setReviewStatus(view.review_status);
      setDraftWarning(view.warning);
      setDraftFailure(view.failure);
      setSourceFilename(view.source_filename);
      setSizeBytes(view.size_bytes);

      const review = view.review_payload;
      if (review === null) return;

      setFields((prev) => {
        const next: IntakeState = { ...prev };
        for (const [key, cell] of Object.entries(review.fields)) {
          const localProv = provenance[key] as Provenance | undefined;
          if (preserveEdited && localProv === 'edited') continue; // recruiter wins
          if (typeof cell.value === 'boolean') {
            (next as unknown as Record<string, boolean>)[key] = cell.value;
          } else if (typeof cell.value === 'string') {
            (next as unknown as Record<string, string>)[key] = cell.value;
          }
        }
        return next;
      });
      setProvenance((prev) => {
        const next: ProvenanceMap = { ...prev };
        for (const [key, cell] of Object.entries(review.fields)) {
          if (preserveEdited && next[key] === 'edited') continue;
          if (typeof cell.value === 'string' && cell.value !== '') {
            next[key] = provenanceFromOrigin(cell.origin);
          }
        }
        return next;
      });
      // Arrays — take from the persisted review unless the recruiter has started
      // editing locally (tracked by a non-empty local set with edits).
      if (review.work_history !== undefined && (!preserveEdited || workHistory.length === 0)) {
        setWorkHistory(review.work_history as WorkHistoryDraft[]);
      }
      if (review.education !== undefined && (!preserveEdited || education.length === 0)) {
        setEducation(review.education as EducationDraft[]);
      }
      if (review.certifications !== undefined && (!preserveEdited || certifications.length === 0)) {
        setCertifications(review.certifications as CertificationDraft[]);
      }
      skillsCarryRef.current = review.skills as unknown[] | undefined;
    },
    [provenance, workHistory.length, education.length, certifications.length],
  );

  // ── Reopen (?draft=<id>) — fully restore from backend state ─────────────
  useEffect(() => {
    if (reopenDraftId === null) return;
    let cancelled = false;
    setDraftId(reopenDraftId);
    setPhase('form');
    getTalentIntakeDraft(reopenDraftId)
      .then((view) => {
        if (cancelled) return;
        if (view.review_status === 'PROMOTED' && view.promoted_talent_record_id !== null) {
          // Already promoted → resolve cleanly to the created Talent (no re-create).
          navigate(`/talent/${view.promoted_talent_record_id}`);
          return;
        }
        hydrateFromView(view, true);
      })
      .catch((err) => {
        if (!cancelled) setUploadError(uploadErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reopenDraftId]);

  // ── Watch: notify-on-change (SSE) + poll fallback while processing ──────
  const refetchDraft = useCallback(async () => {
    if (draftId === null) return;
    try {
      const view = await getTalentIntakeDraft(draftId);
      hydrateFromView(view, true);
    } catch {
      // Non-fatal — GET stays authoritative; the next tick/open retries.
    }
  }, [draftId, hydrateFromView]);

  useEffect(() => {
    if (draftId === null || isTerminal || phase === 'success') return;
    // SSE triggers a refetch only (notification-only); GET is the source of truth.
    const closeSse = openTalentIntakeEvents(draftId, () => {
      void refetchDraft();
    });
    // Polling fallback (only if SSE is dropped/absent) — GET every few seconds.
    let active = true;
    const tick = (): void => {
      if (!active) return;
      void refetchDraft().finally(() => {
        if (active) window.setTimeout(tick, 2500);
      });
    };
    const first = window.setTimeout(tick, 2500);
    return () => {
      active = false;
      window.clearTimeout(first);
      closeSse();
    };
  }, [draftId, isTerminal, phase, refetchDraft]);

  // ── Autosave: persist recruiter edits after processing is terminal ──────
  const flushSave = useCallback(async (): Promise<void> => {
    if (draftId === null || !reviewDirty) return;
    try {
      const view = await patchTalentIntakeReview(draftId, {
        review: buildReviewPayload(),
        expected_version: versionRef.current,
      });
      setVersion(view.version);
      setReviewStatus(view.review_status);
      setReviewDirty(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Stale version (the worker advanced it) — refetch (merge preserves our
        // edits) and leave dirty so the next pass re-saves against the new version.
        await refetchDraft();
      }
      // Other errors: keep dirty; autosave retries on the next edit/flush.
    }
  }, [draftId, reviewDirty, buildReviewPayload, refetchDraft]);

  useEffect(() => {
    if (!reviewDirty || draftId === null || !isTerminal || reviewStatus === 'PROMOTED') return;
    const t = window.setTimeout(() => {
      void flushSave();
    }, 800);
    return () => window.clearTimeout(t);
  }, [reviewDirty, draftId, isTerminal, reviewStatus, flushSave]);

  // ── Field editing ───────────────────────────────────────────────────────
  function markDirty(): void {
    setReviewDirty(true);
  }
  function onField(key: keyof IntakeState, value: string): void {
    setFields((s) => ({ ...s, [key]: value }));
    setProvenance((p) => {
      const prev = p[key as string] as Provenance | undefined;
      const next = prev === 'governed_llm' || prev === 'edited' ? 'edited' : undefined;
      const updated = { ...p };
      // A recruiter-typed value with no prior provenance is a recruiter edit.
      updated[key as string] = next ?? 'edited';
      return updated;
    });
    markDirty();
  }
  function onToggle(key: 'can_relocate' | 'is_hot'): void {
    setFields((s) => ({ ...s, [key]: !s[key] }));
    markDirty();
  }
  function onWorkHistoryField(index: number, key: keyof WorkHistoryDraft, value: string): void {
    setWorkHistory((prev) => prev.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
    markDirty();
  }
  function onAddWorkHistory(): void {
    setWorkHistory((prev) => [...prev, { employer_name: '', role_title: '' }]);
    markDirty();
  }
  function onRemoveWorkHistory(index: number): void {
    setWorkHistory((prev) => prev.filter((_, i) => i !== index));
    markDirty();
  }

  // ── Upload flow (async; never calls the old synchronous endpoint) ───────
  async function handleFile(file: File): Promise<void> {
    setPhase('processing');
    setUploadError(null);
    setUploadFile(file);
    setSourceFilename(file.name);
    setSizeBytes(file.size);
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;

    let draft;
    try {
      // 1 — create intake (presigned upload target; NO LLM work on this request).
      draft = await createTalentIntakeDraft({ filename: file.name, content_type: contentType });
    } catch (err) {
      setUploadError(uploadErrorMessage(err));
      setPhase('intake');
      return;
    }
    setDraftId(draft.draft_id);

    try {
      // 2 — upload the bytes directly to object storage.
      await putResumeToStorage(draft.upload_url, file, contentType);
    } catch (err) {
      setUploadError(uploadErrorMessage(err));
      setPhase('intake');
      return;
    }

    try {
      // 3 — complete upload → QUEUED + outbox, returns 202. Extraction runs async.
      const accepted = await completeTalentIntakeUpload(draft.draft_id);
      setProcessingStatus(accepted.processing_status);
    } catch (err) {
      setUploadError(uploadErrorMessage(err));
      // The object IS uploaded — go to the form so the recruiter can still work
      // and promote once required fields are set (failure is recoverable).
      setPhase('form');
      return;
    }
    // Move to the review form immediately; the watch effect streams/poll the
    // extraction result and hydrates untouched fields when it lands.
    setPhase('form');
  }

  async function onRetry(): Promise<void> {
    if (draftId === null) return;
    try {
      const view = await retryTalentIntakeExtraction(draftId);
      hydrateFromView(view, true);
    } catch (err) {
      setUploadError(uploadErrorMessage(err));
    }
  }

  function resetAll(): void {
    setPhase('intake');
    setDraftId(null);
    setVersion(0);
    setProcessingStatus('UPLOADED');
    setReviewStatus('NOT_STARTED');
    setDraftWarning(null);
    setDraftFailure(null);
    setUploadFile(null);
    setSourceFilename(null);
    setSizeBytes(null);
    setUploadError(null);
    setFields(emptyIntakeState());
    setProvenance({});
    setWorkHistory([]);
    setEducation([]);
    setCertifications([]);
    skillsCarryRef.current = undefined;
    setSubmitting(false);
    setSubmitError(null);
    setMissingFields(null);
    setDuplicate(null);
    setCreated(null);
    setReviewDirty(false);
    navigate('/talent/new');
  }

  // ── Save gate ───────────────────────────────────────────────────────────
  const email1 = fields.email1.trim();
  useEffect(() => {
    if (!/\S+@\S+\.\S+/.test(email1)) {
      setDuplicate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      checkTalentDuplicate(email1)
        .then((res) => {
          if (!cancelled) setDuplicate(res.match);
        })
        .catch(() => {
          if (!cancelled) setDuplicate(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email1]);

  const nameOk = fields.first_name.trim() !== '' && fields.last_name.trim() !== '';
  const emailOk = /\S+@\S+\.\S+/.test(fields.email1.trim());
  const phoneOk = fields.phone_cell.trim() !== '';
  const cityOk = fields.city.trim() !== '';
  const stateOk = fields.state.trim() !== '';
  const resumeOk = draftId !== null;
  const canCreate =
    nameOk && emailOk && phoneOk && cityOk && stateOk && resumeOk && duplicate === null && !submitting;

  // ── Promote (replaces direct createTalent for the résumé-first flow) ────
  async function onCreate(): Promise<void> {
    if (!canCreate || draftId === null) return;
    setSubmitting(true);
    setSubmitError(null);
    setMissingFields(null);
    // Persist the latest edits before promoting.
    await flushSave();
    try {
      const record = await promoteTalentIntakeDraft(draftId);
      setCreated(record);
      setPhase('success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TALENT_RECORD_DUPLICATE') {
        const existing = err.details?.['existing_id'];
        const existingId = typeof existing === 'string' ? existing : undefined;
        const fallback: TalentDuplicateMatch | null =
          existingId === undefined
            ? null
            : {
                id: existingId,
                first_name: fields.first_name,
                last_name: fields.last_name,
                title: fields.title === '' ? null : fields.title,
                city: fields.city === '' ? null : fields.city,
                state: fields.state === '' ? null : fields.state,
              };
        try {
          const res = await checkTalentDuplicate(email1);
          setDuplicate(res.match ?? fallback);
        } catch {
          setDuplicate(fallback);
        }
      } else if (
        err instanceof ApiError &&
        err.status === 422 &&
        Array.isArray(err.details?.['missing'])
      ) {
        setMissingFields(err.details['missing'] as string[]);
      } else {
        setSubmitError(createErrorMessage(err));
      }
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (phase === 'success' && created !== null) {
    return (
      <>
        <SuccessScreen
          name={`${created.first_name} ${created.last_name}`}
          onOpen={() => navigate(`/talent/${created.id}`)}
          onAnother={resetAll}
          onRecordConsent={() => setConsentOpen(true)}
        />
        {consentOpen && (
          <RecordConsentDialog
            talentRecordId={created.id}
            open={consentOpen}
            onOpenChange={setConsentOpen}
          />
        )}
      </>
    );
  }

  return (
    <section className="rc-addtalent">
      <PageHeader title="Add talent" description={headerDescription} />

      {phase === 'intake' ? (
        <div className="rc-stepwrap">
          <div className="rc-stepintro">
            <div className="rc-stepeyebrow">Step 1 of 2 · Source</div>
            <h2 className="rc-steptitle">Start with the résumé</h2>
            <p className="rc-stepdesc">
              Aramo reads it in the background — you can leave and come back any
              time. Nothing is created until you review and confirm.
            </p>
          </div>
          {uploadError !== null ? (
            <InlineAlert variant="error">{uploadError}</InlineAlert>
          ) : null}
          <ResumeDropzone onFile={handleFile} />
          <p className="rc-stepreq">A résumé is required to create a Talent record.</p>
          <div className="rc-stepcancel">
            <Button unstyled type="button" className="rc-btn" onClick={() => navigate('/talent')}>
              Cancel
            </Button>
            <p className="rc-stepcancel__note">
              Contact permissions are governed separately from profile creation ·
              provenance is recorded automatically.
            </p>
          </div>
        </div>
      ) : null}

      {phase === 'processing' ? (
        <ParseProgress phase="uploading" fileName={sourceFilename ?? 'résumé'} />
      ) : null}

      {phase === 'form' ? (
        <div className="rc-editgrid">
          <div className="rc-editgrid__main">
            <div className="rc-stephdr">
              <Button
                unstyled
                type="button"
                className="rc-step__back"
                disabled={submitting}
                onClick={() => navigate('/talent/drafts')}
              >
                ← Draft talents
              </Button>
              <span className="rc-stepeyebrow">Step 2 of 2 · Review &amp; create</span>
            </div>

            <ProcessingBanner
              processingStatus={processingStatus}
              failure={draftFailure}
              onRetry={onRetry}
            />
            {draftWarning !== null && processingStatus !== 'FAILED' ? (
              <div className="rc-warnnote" role="status">
                {draftWarning}
              </div>
            ) : null}
            {missingFields !== null ? (
              <InlineAlert variant="error">
                A name, a primary email, and a cell phone are required to create a
                talent ({missingFields.join(', ')}).
              </InlineAlert>
            ) : null}
            {duplicate !== null ? (
              <DupMatchCard
                match={duplicate}
                email={email1}
                onReview={(id) => navigate(`/talent/${id}`)}
                onDifferent={() => onField('email1', '')}
              />
            ) : null}
            {submitError !== null ? (
              <InlineAlert variant="error">{submitError}</InlineAlert>
            ) : null}
            <IntakeForm
              values={fields}
              provenance={provenance}
              workHistory={workHistory}
              education={education}
              certifications={certifications}
              disabled={submitting}
              onField={onField}
              onToggle={onToggle}
              onWorkHistoryField={onWorkHistoryField}
              onAddWorkHistory={onAddWorkHistory}
              onRemoveWorkHistory={onRemoveWorkHistory}
            />
          </div>

          <aside className="rc-editgrid__rail">
            {sourceFilename !== null ? (
              <ResumeCard fileName={sourceFilename} sizeBytes={sizeBytes ?? 0} />
            ) : null}
            <RequirementList
              gates={[
                { ok: nameOk, label: 'First and last name' },
                { ok: emailOk, label: 'Email address' },
                { ok: phoneOk, label: 'Phone number' },
                { ok: cityOk && stateOk, label: 'City and state' },
                { ok: resumeOk, label: 'Résumé attached' },
              ]}
            />
            <p className="rc-secnote">
              Work authorization and desired rate are optional — capture them later
              if the résumé doesn’t state them.
            </p>
            {uploadFile !== null ? (
              <ResumePreview file={uploadFile} fileName={uploadFile.name} mime={uploadFile.type} />
            ) : null}
          </aside>
        </div>
      ) : null}

      {phase === 'form' ? (
        <div className="rc-addfoot">
          <div className="rc-addfoot__actions">
            <Button
              unstyled
              type="button"
              className="rc-btn rc-btn--primary"
              disabled={!canCreate || submitting}
              onClick={onCreate}
            >
              <Icons.IconCheck />
              {submitting ? 'Creating…' : 'Create talent'}
            </Button>
            <Button
              unstyled
              type="button"
              className="rc-btn"
              disabled={submitting}
              onClick={() => navigate('/talent/drafts')}
            >
              Save &amp; close
            </Button>
          </div>
          <p className="rc-addfoot__note">
            Your draft is saved automatically — you can leave and finish later.
            Contact permissions are governed separately from profile creation.
          </p>
        </div>
      ) : null}
    </section>
  );
}

// ── Processing / failure banner ──────────────────────────────────────────────
function ProcessingBanner({
  processingStatus,
  failure,
  onRetry,
}: {
  readonly processingStatus: string;
  readonly failure: string | null;
  readonly onRetry: () => void;
}) {
  if (processingStatus === 'FAILED') {
    return (
      <InlineAlert variant="error">
        {failure ?? 'We couldn’t prepare the résumé details. Your uploaded résumé is safe.'}{' '}
        <Button unstyled type="button" className="rc-linkbtn" onClick={onRetry}>
          Retry extraction
        </Button>{' '}
        or complete the fields below manually.
      </InlineAlert>
    );
  }
  if (processingStatus === 'READY' || processingStatus === 'PARTIAL') {
    return (
      <div className="rc-parsedpill">
        <Icons.IconCheck />
        <span>Résumé read — review the proposed values below.</span>
      </div>
    );
  }
  // UPLOADED / QUEUED / PROCESSING
  return (
    <div className="rc-warnnote" role="status" aria-live="polite">
      Reading résumé… you can leave this page — we’ll keep processing it, and your
      draft is saved.
    </div>
  );
}

// ── Duplicate-match card ─────────────────────────────────────────────────────
function DupMatchCard({
  match,
  email,
  onReview,
  onDifferent,
}: {
  readonly match: TalentDuplicateMatch;
  readonly email: string;
  readonly onReview: (id: string) => void;
  readonly onDifferent: () => void;
}) {
  const name = `${match.first_name} ${match.last_name}`.trim();
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '—';
  const location = [match.city, match.state].filter((v) => v && v.trim() !== '').join(', ');
  const context = [match.title ?? '', location].filter((v) => v.trim() !== '').join(' · ');
  return (
    <div className="rc-dupcard" role="alert">
      <div className="rc-dupcard__hd">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 3l10 18H2z" />
          <path d="M12 10v5M12 17.5v.5" />
        </svg>
        <span className="rc-dupcard__t">Possible existing Talent</span>
      </div>
      <div className="rc-dupcard__body">
        <span className="rc-dupcard__av">{initials}</span>
        <span className="rc-dupcard__who">
          <span className="rc-dupcard__nm">{name === '' ? 'This person' : name}</span>
          {context !== '' ? <span className="rc-dupcard__ctx">{context}</span> : null}
          <span className="rc-dupcard__sig">
            Matched signal: Email{email !== '' ? ` · ${email}` : ''}
          </span>
        </span>
        <span className="rc-dupcard__acts">
          <Button unstyled type="button" className="rc-dupcard__review" onClick={() => onReview(match.id)}>
            Review existing Talent
          </Button>
          <Button unstyled type="button" className="rc-dupcard__diff" onClick={onDifferent}>
            Use a different email
          </Button>
        </span>
      </div>
      <div className="rc-dupcard__foot">
        No silent merge — identity resolution is a human decision. This primary
        email already exists in your tenant, so Create is blocked.
      </div>
    </div>
  );
}

// ── Right-rail résumé card ───────────────────────────────────────────────────
function ResumeCard({
  fileName,
  sizeBytes,
}: {
  readonly fileName: string;
  readonly sizeBytes: number;
}) {
  return (
    <section className="rc-sidecard rc-resumecard" aria-label="Résumé">
      <h3 className="rc-sidecard__h">
        <Icons.IconFile />
        Résumé
      </h3>
      <div className="rc-resumecard__file">
        <span className="rc-resumecard__fic" aria-hidden="true">
          <Icons.IconFile />
        </span>
        <div>
          <div className="rc-resumecard__fn">{fileName}</div>
          <div className="rc-resumecard__fm">
            {sizeBytes > 0 ? `${Math.max(1, Math.round(sizeBytes / 1024))} KB · ` : ''}attached
          </div>
        </div>
      </div>
      <p className="rc-consent__note">
        <Icons.IconShield />
        <span>
          SSN-shaped patterns are redacted before the résumé text is stored (D4).
          Résumé text purges on delete (ADR-0015 cascade).
        </span>
      </p>
    </section>
  );
}

// ── Requirement checklist ────────────────────────────────────────────────────
function RequirementList({
  gates,
}: {
  readonly gates: ReadonlyArray<{ ok: boolean; label: string }>;
}) {
  return (
    <section className="rc-savebar" aria-label="Required to create">
      <h3 className="rc-savebar__h">Required to create</h3>
      <ul className="rc-savebar__gates">
        {gates.map((g) => (
          <GateRow key={g.label} ok={g.ok} label={g.label} />
        ))}
      </ul>
    </section>
  );
}

function GateRow({ ok, label }: { readonly ok: boolean; readonly label: string }) {
  return (
    <li className={`rc-gate-row${ok ? ' rc-gate-row--ok' : ''}`}>
      {ok ? <Icons.IconCheck /> : <Icons.IconInfo />}
      {label}
    </li>
  );
}

// ── Success screen ───────────────────────────────────────────────────────────
function SuccessScreen({
  name,
  onOpen,
  onAnother,
  onRecordConsent,
}: {
  readonly name: string;
  readonly onOpen: () => void;
  readonly onAnother: () => void;
  readonly onRecordConsent: () => void;
}) {
  return (
    <section className="rc-success">
      <div className="rc-success__ic" aria-hidden="true">
        <Icons.IconCheck />
      </div>
      <h2>{name} added to your talent</h2>
      <p>Profile created, résumé attached and queued for indexing.</p>
      <p>
        Contact permissions are separate from the profile. Record the Talent&apos;s
        consent to enable recruiter email, phone and matching.
      </p>
      <div className="rc-success__btns">
        <Button unstyled type="button" className="rc-btn rc-btn--primary" onClick={onRecordConsent}>
          Record consent
        </Button>
        <Button unstyled type="button" className="rc-btn" onClick={onOpen}>
          Open profile
        </Button>
        <Button unstyled type="button" className="rc-btn" onClick={onAnother}>
          Add another
        </Button>
      </div>
    </section>
  );
}
