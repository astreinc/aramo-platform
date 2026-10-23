import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, Button, useToast } from '@aramo/fe-foundation';

import { useMe } from '../shell/me-api';
import { Icons, InlineAlert, PageHeader, StatusPill } from '../ui';
// (Consent is captured on Talent 360 after create — no interstitial screen, §16.)

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
  createManualTalentIntakeDraft,
  createTalentIntakeDraft,
  discardTalentIntakeDraft,
  getTalentIntakeDraft,
  openTalentIntakeEvents,
  patchTalentIntakeReview,
  listTalentIntakeDrafts,
  promoteTalentIntakeDraft,
  replaceTalentIntakeResume,
  retryTalentIntakeExtraction,
  type TalentIntakeDraftListItem,
  type TalentIntakeDraftView,
  type TalentIntakeReviewPayload,
} from './talent-intake-api';
import { draftTitle, inProgressDrafts, presentDraft } from './draft-recovery';
import { createErrorMessage, uploadErrorMessage } from './error-messages';
import { emptyIntakeState, INTAKE_TEXT_KEYS, type IntakeState } from './intake-fields';
import type { Provenance, ProvenanceMap } from './provenance';
import type {
  CertificationDraft,
  EducationDraft,
  TalentRecordView,
  WorkHistoryDraft,
} from './types';

// Durable Async Resume-First Add-Talent. The browser is NOT part of the
// durability boundary: a resume upload persists a TalentIntakeDraft; extraction
// runs asynchronously in a worker; the recruiter can leave and return (any
// session/device) via Draft Talents or ?draft=<id>. GET is authoritative; SSE
// is notification-only (triggers a refetch); the Talent is created only on an
// idempotent PROMOTE. The old synchronous draft-from-resume path is retired.
//
// Phases: intake (dropzone OR "Enter details manually") → processing
// (upload+commit) → form (review, with a live processing banner + persisted
// edits) → success. ?draft restores a persisted draft fully from backend state.
// ATI-SEP-1 A5: a resume is optional — manual entry creates an artifact-less
// draft (settled READY by the backend) and uses the same review + promote path.

type Phase = 'intake' | 'processing' | 'form';

const TERMINAL = new Set(['READY', 'PARTIAL', 'FAILED']);

function reviewFieldOrigin(p: Provenance | undefined): 'RESUME_EXTRACTION' | 'RECRUITER' {
  return p === 'governed_llm' ? 'RESUME_EXTRACTION' : 'RECRUITER';
}

function provenanceFromOrigin(origin: string): Provenance {
  return origin === 'RESUME_EXTRACTION' ? 'governed_llm' : 'edited';
}

type ReviewArrayKey = 'work_history' | 'education' | 'certifications';

function cleanArrayFlags(): Record<ReviewArrayKey, boolean> {
  return { work_history: false, education: false, certifications: false };
}

export function TalentCreateView() {
  const navigate = useNavigate();
  const me = useMe();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const reopenDraftId = searchParams.get('draft');
  // Talent Draft Recovery (§11/§17) — preserve origin so the backlink and
  // Save & close return to In progress when that is where the recruiter came from.
  const fromInProgress = searchParams.get('from') === 'in-progress';
  const backTo = fromInProgress ? '/talent?view=in-progress' : '/talent';
  // §8 — the actor's other in-progress drafts, offered as "Continue adding (n)"
  // on Step 1 when starting fresh (never when reopening a specific draft).
  const [intakeDrafts, setIntakeDrafts] = useState<TalentIntakeDraftListItem[]>([]);
  useEffect(() => {
    if (reopenDraftId !== null) return;
    let cancelled = false;
    listTalentIntakeDrafts()
      .then((r) => {
        if (!cancelled) setIntakeDrafts(r.items);
      })
      .catch(() => {
        if (!cancelled) setIntakeDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [reopenDraftId]);

  const authorName = me?.user.display_name ?? me?.user.email ?? 'you';
  const addedToday = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const headerDescription = `Start from a resume or enter details manually · source is recorded automatically ("Added manually by ${authorName} · ${addedToday}")`;

  const [phase, setPhase] = useState<Phase>('intake');

  // Durable draft identity + its persisted lifecycle (GET is authoritative).
  const [draftId, setDraftId] = useState<string | null>(null);
  const [version, setVersion] = useState<number>(0);
  const [processingStatus, setProcessingStatus] = useState<string>('UPLOADED');
  const [reviewStatus, setReviewStatus] = useState<string>('NOT_STARTED');
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);

  // Resume artifact context. uploadFile is present only on a fresh upload (for
  // the live preview); on reopen we have filename/size from the draft.
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [startingManual, setStartingManual] = useState(false);
  // True once a persisted draft view has been applied — the banner waits for it
  // on ?draft= reopen so it never states a resume/no-resume fact before GET.
  const [draftLoaded, setDraftLoaded] = useState(false);

  // Form state (the review).
  const [fields, setFields] = useState<IntakeState>(emptyIntakeState);
  const [provenance, setProvenance] = useState<ProvenanceMap>({});
  const [workHistory, setWorkHistory] = useState<WorkHistoryDraft[]>([]);
  const [education, setEducation] = useState<readonly EducationDraft[]>([]);
  const [certifications, setCertifications] = useState<readonly CertificationDraft[]>([]);
  // ATS-QA-1 I-3 (Durable-Async I7 / §8.5) — which evidence arrays the recruiter
  // has edited since the last successful save. Only those arrays are sent; the
  // backend owns the per-array origin and keeps every other array (so a save can
  // never wipe extracted work history / education / certifications). Structured
  // skills are backend-owned and never sent.
  const arrayDirtyRef = useRef<Record<ReviewArrayKey, boolean>>(cleanArrayFlags());
  // Monotonic edit counter — a save only clears the dirty state when no newer
  // edit happened while it was in flight.
  const editSeqRef = useRef(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [duplicate, setDuplicate] = useState<TalentDuplicateMatch | null>(null);
  // ATI-SEP-1 D6 — the Save already created this Talent (it is finishing its
  // follow-ups), so the backend refuses further draft edits (409
  // INTAKE_DRAFT_SAVED_EDIT_ON_TALENT). Holds that Talent's id; the recruiter is
  // directed to the Talent record to make the change there.
  const [editOnTalentId, setEditOnTalentId] = useState<string | null>(null);
  const editOnTalentRef = useRef<string | null>(null);

  // Autosave bookkeeping.
  const [reviewDirty, setReviewDirty] = useState(false);
  const versionRef = useRef(version);
  versionRef.current = version;
  // Latest form state for callbacks that run after an await (409 retry,
  // hydrate) — avoids acting on a stale render's closure.
  const latestRef = useRef({ fields, provenance, workHistory, education, certifications });
  latestRef.current = { fields, provenance, workHistory, education, certifications };

  const isTerminal = TERMINAL.has(processingStatus);

  // ── review_payload <-> form mapping ─────────────────────────────────────
  const buildReviewPayload = useCallback((): TalentIntakeReviewPayload => {
    const { fields, provenance, workHistory, education, certifications } = latestRef.current;
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
    const dirty = arrayDirtyRef.current;
    return {
      fields: outFields,
      // Arrays ride the save ONLY when the recruiter edited them (I7 / §8.5).
      ...(dirty.work_history
        ? {
            work_history: workHistory.filter(
              (e) => e.employer_name.trim() !== '' || e.role_title.trim() !== '',
            ),
          }
        : {}),
      ...(dirty.education ? { education: [...education] } : {}),
      ...(dirty.certifications ? { certifications: [...certifications] } : {}),
    };
  }, []);

  // Hydrate the form from a persisted draft view. preserveEdited keeps local
  // recruiter edits (late extraction must never overwrite a recruiter value).
  const hydrateFromView = useCallback(
    (view: TalentIntakeDraftView, preserveEdited: boolean) => {
      setDraftLoaded(true);
      setVersion(view.version);
      setProcessingStatus(view.processing_status);
      setReviewStatus(view.review_status);
      setDraftWarning(view.warning);
      setDraftFailure(view.failure);
      setSourceFilename(view.source_filename);
      setSizeBytes(view.size_bytes);

      const review = view.review_payload;
      if (review === null) return;

      const localProvenance = latestRef.current.provenance;
      setFields((prev) => {
        const next: IntakeState = { ...prev };
        for (const [key, cell] of Object.entries(review.fields)) {
          const localProv = localProvenance[key] as Provenance | undefined;
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
      // Arrays — take the persisted (backend-merged) value unless the recruiter
      // has unsaved local edits to THAT array, which win until they are saved.
      const dirty = arrayDirtyRef.current;
      if (review.work_history !== undefined && (!preserveEdited || !dirty.work_history)) {
        setWorkHistory(review.work_history as WorkHistoryDraft[]);
      }
      if (review.education !== undefined && (!preserveEdited || !dirty.education)) {
        setEducation(review.education as EducationDraft[]);
      }
      if (review.certifications !== undefined && (!preserveEdited || !dirty.certifications)) {
        setCertifications(review.certifications as CertificationDraft[]);
      }
    },
    [],
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
    if (draftId === null || isTerminal) return;
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

  // ── Autosave: persist recruiter edits at ANY processing state ───────────
  // ATI-SEP-1 A5 — saves run while the resume is still QUEUED/PROCESSING too
  // (the banner promises progress is saved). The backend merge keeps every
  // RECRUITER-origin field when the extraction lands, so an early save is never
  // overwritten. Returns true when nothing is left unsaved. A 409 (the worker or another tab
  // advanced the version) refetches the authoritative draft — the backend merge
  // keeps every extracted value — and re-sends the recruiter's edits once
  // against the new version, so a create right after a late extraction never
  // drops either side.
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (draftId === null || !reviewDirty) return true;
    // D6 — the backend refuses every further edit once the Talent exists.
    if (editOnTalentRef.current !== null) return false;
    const seq = editSeqRef.current;
    const save = async () => {
      const view = await patchTalentIntakeReview(draftId, {
        review: buildReviewPayload(),
        expected_version: versionRef.current,
      });
      versionRef.current = view.version;
      setVersion(view.version);
      setReviewStatus(view.review_status);
      if (editSeqRef.current === seq) {
        arrayDirtyRef.current = cleanArrayFlags();
        setReviewDirty(false);
      }
    };
    try {
      await save();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INTAKE_DRAFT_SAVED_EDIT_ON_TALENT') {
        // Not a stale version — re-sending can never succeed. Direct the
        // recruiter to the Talent record instead.
        const talentId = err.details?.['talent_record_id'];
        if (typeof talentId === 'string') {
          editOnTalentRef.current = talentId;
          setEditOnTalentId(talentId);
        }
        return false;
      }
      if (!(err instanceof ApiError && err.status === 409)) {
        // Keep dirty; autosave retries on the next edit/flush.
        return false;
      }
    }
    try {
      const latest = await getTalentIntakeDraft(draftId);
      versionRef.current = latest.version;
      hydrateFromView(latest, true);
      await save();
      return true;
    } catch {
      return false;
    }
  }, [draftId, reviewDirty, buildReviewPayload, hydrateFromView]);

  useEffect(() => {
    if (!reviewDirty || draftId === null || reviewStatus === 'PROMOTED' || editOnTalentId !== null) return;
    const t = window.setTimeout(() => {
      void flushSave();
    }, 800);
    return () => window.clearTimeout(t);
  }, [reviewDirty, draftId, reviewStatus, editOnTalentId, flushSave]);

  // ── Field editing ───────────────────────────────────────────────────────
  function markDirty(): void {
    editSeqRef.current += 1;
    setReviewDirty(true);
  }
  function markArrayDirty(key: ReviewArrayKey): void {
    arrayDirtyRef.current = { ...arrayDirtyRef.current, [key]: true };
    markDirty();
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
    markArrayDirty('work_history');
  }
  function onAddWorkHistory(): void {
    setWorkHistory((prev) => [...prev, { employer_name: '', role_title: '' }]);
    markArrayDirty('work_history');
  }
  function onRemoveWorkHistory(index: number): void {
    setWorkHistory((prev) => prev.filter((_, i) => i !== index));
    markArrayDirty('work_history');
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
      // and promote once required fields are set (failure is recoverable). The
      // draft stays UPLOADED, so the banner offers Try again (retry re-runs
      // complete-upload server-side) and Replace resume.
      setProcessingStatus('UPLOADED');
      setPhase('form');
      return;
    }
    // Move to the review form immediately; the watch effect streams/poll the
    // extraction result and hydrates untouched fields when it lands.
    setPhase('form');
  }

  // ATI-SEP-1 A5 — manual entry: no resume. The backend returns a draft already
  // settled READY (nothing to read), and the same review form opens on it.
  async function onManualEntry(): Promise<void> {
    setUploadError(null);
    setStartingManual(true);
    try {
      const view = await createManualTalentIntakeDraft();
      setDraftId(view.id);
      setUploadFile(null);
      hydrateFromView(view, false);
      setPhase('form');
    } catch (err) {
      setUploadError(createErrorMessage(err));
    } finally {
      setStartingManual(false);
    }
  }

  async function onRetry(): Promise<void> {
    if (draftId === null) return;
    setUploadError(null);
    try {
      const view = await retryTalentIntakeExtraction(draftId);
      hydrateFromView(view, true);
    } catch (err) {
      setUploadError(uploadErrorMessage(err));
    }
  }

  // §15/§18 — discard the unfinished draft (e.g. from the duplicate panel: the
  // recruiter decided it IS the existing Talent) and return to the origin.
  async function onDiscardDraft(): Promise<void> {
    if (draftId === null) {
      navigate(backTo);
      return;
    }
    try {
      await discardTalentIntakeDraft(draftId);
    } catch {
      // The draft may already be gone; returning to Talent is still correct.
    }
    navigate(backTo);
  }

  // §13 — replace the resume on this draft: mint a fresh upload target, PUT the
  // new file, then complete-upload to re-queue extraction (same durable path).
  async function onReplaceResume(file: File): Promise<void> {
    if (draftId === null) return;
    setUploadError(null);
    try {
      const presign = await replaceTalentIntakeResume(draftId, {
        filename: file.name,
        content_type: file.type === '' ? 'application/octet-stream' : file.type,
      });
      await fetch(presign.upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
      });
      await completeTalentIntakeUpload(draftId);
      const view = await getTalentIntakeDraft(draftId);
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
    setDraftLoaded(false);
    setUploadFile(null);
    setSourceFilename(null);
    setSizeBytes(null);
    setUploadError(null);
    setFields(emptyIntakeState());
    setProvenance({});
    setWorkHistory([]);
    setEducation([]);
    setCertifications([]);
    arrayDirtyRef.current = cleanArrayFlags();
    setSubmitting(false);
    setSubmitError(null);
    setMissingFields(null);
    setDuplicate(null);
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
  // Create authority (§9/§13) — canonical admission ONLY (name + email + phone).
  // A resume is NOT required and city/state are optional completeness guidance
  // (ATS-QA-1 row A1), never creation gates and never shown as required. An active-email duplicate is the one backend-authoritative
  // block (the 409 is preserved — PO ruling), surfaced via `duplicate`.
  const canCreate = nameOk && emailOk && phoneOk && duplicate === null && !submitting;

  // ── Promote (replaces direct createTalent for the resume-first flow) ────
  async function onCreate(): Promise<void> {
    if (!canCreate || draftId === null) return;
    setSubmitting(true);
    setSubmitError(null);
    setMissingFields(null);
    // Persist the latest edits before promoting. If they cannot be saved, stop:
    // promoting now would create the Talent without them.
    const saved = await flushSave();
    if (!saved && editOnTalentRef.current !== null) {
      // The Talent already exists: finish its Save, then open the Talent record,
      // where the recruiter makes the change the draft could no longer carry.
      try {
        const record = await promoteTalentIntakeDraft(draftId);
        toast.show('Talent created · make your latest changes on the Talent record');
        navigate(`/talent/${record.id}`);
      } catch (err) {
        setSubmitError(createErrorMessage(err));
        setSubmitting(false);
      }
      return;
    }
    if (!saved) {
      setSubmitError('Your latest changes couldn’t be saved. Please try again.');
      setSubmitting(false);
      return;
    }
    try {
      const record = await promoteTalentIntakeDraft(draftId);
      // §16 — on successful promotion: toast then navigate to Talent 360. The
      // draft leaves In progress / Continue adding / the cue immediately because
      // the next list read no longer returns it (review_status = PROMOTED).
      const fullName = `${record.first_name} ${record.last_name}`.trim();
      toast.show(`Talent created · ${fullName}`);
      navigate(`/talent/${record.id}`);
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
  // §16 — successful promotion navigates straight to Talent 360 with a toast;
  // there is no interstitial success screen. Consent is captured on Talent 360
  // (the shipped Consent-Capture surface).

  return (
    <section className="rc-addtalent">
      <PageHeader title="Add talent" description={headerDescription} />

      {phase === 'intake' ? (
        <div className="rc-stepwrap">
          <div className="rc-stepeyebrow">Step 1 of 2 · Resume</div>
          {/* §8 — Continue adding (n): the actor's in-progress drafts, max 3 rows,
              then "View all {n} in progress ›". Starting someone new stays direct
              (no modal, no mandatory chooser) — it's the section right below. */}
          {reopenDraftId === null && inProgressDrafts(intakeDrafts).length > 0 ? (
            <div className="rc-continueadd">
              <div className="rc-continueadd__hd">
                Continue adding ({inProgressDrafts(intakeDrafts).length})
              </div>
              <div className="rc-continueadd__list">
                {inProgressDrafts(intakeDrafts)
                  .slice(0, 3)
                  .map((d) => {
                    const p = presentDraft(d);
                    const { title, file } = draftTitle(d);
                    return (
                      <div key={d.id} className="rc-continueadd__row">
                        <span className="rc-continueadd__nm">
                          {title}
                          <span className="rc-continueadd__file"> · {file}</span>
                        </span>
                        <StatusPill tone={p.pillTone}>{p.label}</StatusPill>
                        <Link
                          to={`/talent/new?draft=${encodeURIComponent(d.id)}&from=in-progress`}
                          className="rc-hbtn rc-hbtn--primary"
                        >
                          Continue
                        </Link>
                      </div>
                    );
                  })}
              </div>
              {inProgressDrafts(intakeDrafts).length > 3 ? (
                <Link to="/talent?view=in-progress" className="rc-continueadd__all">
                  View all {inProgressDrafts(intakeDrafts).length} in progress ›
                </Link>
              ) : null}
            </div>
          ) : null}
          <div className="rc-stepintro">
            <h2 className="rc-steptitle">
              {reopenDraftId === null && inProgressDrafts(intakeDrafts).length > 0
                ? 'Or start someone new'
                : 'Start with the resume'}
            </h2>
            <p className="rc-stepdesc">
              Aramo reads it in the background — you can leave and come back any
              time. Nothing is created until you review and confirm.
            </p>
          </div>
          {uploadError !== null ? (
            <InlineAlert variant="error">{uploadError}</InlineAlert>
          ) : null}
          <ResumeDropzone onFile={handleFile} disabled={startingManual} />
          <p className="rc-stepreq">
            Add a resume to prefill details, or{' '}
            <Button
              unstyled
              type="button"
              className="rc-linkbtn"
              disabled={startingManual}
              onClick={() => void onManualEntry()}
            >
              Enter details manually
            </Button>
          </p>
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
        <ParseProgress phase="uploading" fileName={sourceFilename ?? 'resume'} />
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
                onClick={() => navigate(backTo)}
              >
                ← Talent
              </Button>
              <span className="rc-stepeyebrow">Step 2 of 2 · Review &amp; create</span>
            </div>

            {reopenDraftId === null || draftLoaded ? (
              <ProcessingBanner
                processingStatus={processingStatus}
                failure={draftFailure}
                hasResume={sourceFilename !== null}
                onRetry={onRetry}
                onReplace={onReplaceResume}
              />
            ) : null}
            {uploadError !== null ? (
              <InlineAlert variant="error">{uploadError}</InlineAlert>
            ) : null}
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
                onDiscard={onDiscardDraft}
              />
            ) : null}
            {editOnTalentId !== null ? (
              <InlineAlert variant="error">
                This talent has already been created, so changes here can no longer be
                saved. <Link to={`/talent/${editOnTalentId}`}>Open the Talent record</Link>{' '}
                to make them there.
              </InlineAlert>
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

          {/* §20 — compact rail summary shown <760px (the full rail is hidden):
              "{file} · Required to create ▾" with the checklist disclosed on
              toggle. ATS-QA-1 row A1: no "/5 required" count (City/State are
              optional). */}
          <details className="rc-railsummary">
            <summary>
              <Icons.IconFile aria-hidden="true" />
              {sourceFilename ?? 'Manual entry'} · Required to create ▾
            </summary>
            <div className="rc-railsummary__body">
              <RequirementList
                gates={[
                  { ok: nameOk, label: 'First and last name' },
                  { ok: emailOk, label: 'Email address' },
                  { ok: phoneOk, label: 'Phone number' },
                ]}
              />
            </div>
          </details>

          <aside className="rc-editgrid__rail">
            {sourceFilename !== null ? (
              <ResumeCard fileName={sourceFilename} sizeBytes={sizeBytes ?? 0} />
            ) : null}
            <RequirementList
              gates={[
                { ok: nameOk, label: 'First and last name' },
                { ok: emailOk, label: 'Email address' },
                { ok: phoneOk, label: 'Phone number' },
              ]}
            />
            <p className="rc-secnote">
              Work authorization and desired rate are optional — capture them later
              if the resume doesn’t state them.
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
              onClick={() => navigate(backTo)}
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
// ATI-SEP-1 A5 — every state is stated truthfully:
//   - FAILED renders the backend's specific, recruiter-safe failure copy (e.g. a
//     too-long resume vs. a file with no readable text), never a generic line
//     when a specific one exists;
//   - UPLOADED in the form means the upload never reached the queue (the
//     complete-upload call failed) — Try again re-runs it, Replace re-uploads;
//   - PARTIAL is distinct from READY ("Partially read"), never "Resume read";
//   - a manual-entry draft (no resume) says so instead of claiming a read.
const GENERIC_FAILURE =
  'We couldn’t read this resume. Enter the details below — the resume stays attached.';

function ProcessingBanner({
  processingStatus,
  failure,
  hasResume,
  onRetry,
  onReplace,
}: {
  readonly processingStatus: string;
  readonly failure: string | null;
  readonly hasResume: boolean;
  readonly onRetry: () => void;
  readonly onReplace: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recovery = (
    <>
      {/* Genuine native need: a hidden file picker triggered programmatically
          (the fe-foundation Input has no type=file + imperative click). Only PDF
          and DOCX — the extractor reads no other format. */}
      {/* eslint-disable-next-line no-restricted-syntax */}
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx"
        style={{ display: 'none' }}
        data-testid="replace-resume-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f !== undefined) onReplace(f);
          e.target.value = '';
        }}
      />
      <span className="rc-failnote__acts">
        <Button unstyled type="button" className="rc-linkbtn" onClick={onRetry}>
          {processingStatus === 'UPLOADED' ? 'Try again' : 'Try reading again'}
        </Button>
        <Button unstyled type="button" className="rc-linkbtn" onClick={() => fileRef.current?.click()}>
          Replace resume
        </Button>
      </span>
    </>
  );
  if (processingStatus === 'FAILED') {
    // §13 — failure NEVER blocks creation; manual entry remains available and the
    // resume stays attached. Try reading again / Replace resume are the recovery
    // affordances.
    const message = (failure ?? '').trim() || GENERIC_FAILURE;
    return (
      <div className="rc-failnote" role="alert">
        <span>
          <b>Couldn’t read this resume.</b> {message}
        </span>
        {recovery}
      </div>
    );
  }
  if (!hasResume) {
    // Manual entry (or an artifact-less source) — nothing is being read.
    return (
      <div className="rc-readingnote" role="status">
        No resume attached — enter the details below. Your progress is saved.
      </div>
    );
  }
  if (processingStatus === 'UPLOADED') {
    return (
      <div className="rc-failnote" role="alert">
        <span>
          <b>The resume upload didn’t finish.</b> Try again, or enter the details below —
          nothing is lost.
        </span>
        {recovery}
      </div>
    );
  }
  if (processingStatus === 'PARTIAL') {
    return (
      <div className="rc-failnote" role="status">
        <span>
          <b>Partially read — some fields may be missing.</b> Review the values below and
          fill in the rest.
        </span>
        {recovery}
      </div>
    );
  }
  if (processingStatus === 'READY') {
    return (
      <div className="rc-parsedpill">
        <Icons.IconCheck />
        <span>Resume read — review the proposed values below.</span>
      </div>
    );
  }
  // §12 — Reading state is informational (NOT a block): manual editing + creation
  // remain available while extraction runs.
  return (
    <div className="rc-readingnote" role="status" aria-live="polite">
      Reading resume — fields fill in as they’re found. Edit now or leave; your progress is saved.
    </div>
  );
}

// ── Duplicate-match card ─────────────────────────────────────────────────────
function DupMatchCard({
  match,
  email,
  onReview,
  onDiscard,
}: {
  readonly match: TalentDuplicateMatch;
  readonly email: string;
  readonly onReview: (id: string) => void;
  readonly onDiscard: () => void;
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
            Open existing Talent
          </Button>
          {/* §15 / PO ruling — the ONLY other action is Discard. There is NO
              "Continue anyway" in V1 (the active-email 409 is preserved). */}
          <Button unstyled type="button" className="rc-dupcard__diff" onClick={onDiscard}>
            Discard
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

// ── Right-rail resume card ───────────────────────────────────────────────────
function ResumeCard({
  fileName,
  sizeBytes,
}: {
  readonly fileName: string;
  readonly sizeBytes: number;
}) {
  return (
    <section className="rc-sidecard rc-resumecard" aria-label="Resume">
      <h3 className="rc-sidecard__h">
        <Icons.IconFile />
        Resume
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
        <span>SSN-like numbers are removed before the resume text is stored.</span>
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

