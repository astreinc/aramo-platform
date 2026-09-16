import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';

import { useMe } from '../shell/me-api';
import { Icons, InlineAlert, PageHeader } from '../ui';

import { ResumeDropzone } from './ResumeDropzone';
import { ParseProgress } from './ParseProgress';
import { IntakeForm } from './IntakeForm';
import {
  checkTalentDuplicate,
  createAttachment,
  createTalent,
  parseDraftFromResume,
  putResumeToStorage,
  requestResumeUploadUrl,
  type TalentDuplicateMatch,
} from './talent-api';
import {
  attachErrorMessage,
  createErrorMessage,
  uploadErrorMessage,
} from './error-messages';
import {
  applyPrefill,
  buildCreateBody,
  emptyIntakeState,
  provenanceAfterEdit,
  type IntakeState,
} from './intake-fields';
import type { Provenance, ProvenanceMap } from './provenance';
import type {
  CertificationDraft,
  EducationDraft,
  SkillDraft,
  TalentRecordView,
  WorkHistoryDraft,
} from './types';

// R5 (rebuild) — the Add-Talent surface, rebuilt to enterprise-mockup parity.
//
// Phases: intake (dropzone) → parsing (real upload + parse) → form (two-column
// edit + right rail) → success. Manual entry skips straight to the form.
//
// WIRED (real backend, no mock):
//   • Resume S3 flow: presign PUT → direct-to-S3 PUT → deterministic parse
//     (stated facts only, no-LLM per ADR-0015) → create → attach (auto-clears
//     the orphan-pending tag). Attach fires in ALL parse branches; attach is
//     soft-fail (talent is still created).
//   • Provenance chips: REAL signal only (resume / edited).
//
// SEAMS (no backend → no fabrication):
//   • Work history & education — captured AFTER creation as structured
//     evidence (not free text) — surfaced on the Talent record.
//
// Consent / contact permissions are governed SEPARATELY from profile creation
// (not captured here) — see doc/backlog/add-talent-consent-capture.md.

type Phase = 'intake' | 'parsing' | 'form' | 'success';

interface ResumeState {
  readonly status: 'uploading' | 'parsing' | 'ready' | 'error';
  readonly file?: File;
  readonly storage_key?: string;
  readonly error?: string;
}

export function TalentCreateView() {
  const navigate = useNavigate();
  const me = useMe();
  // Header provenance preview — "source is recorded automatically" is literal:
  // this previews the manual-add provenance that will be stamped (the current
  // recruiter + today), mirroring the prototype's example parenthetical.
  const authorName = me?.user.display_name ?? me?.user.email ?? 'you';
  const addedToday = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const headerDescription = `Resume-first creation · source is recorded automatically ("Added manually by ${authorName} · ${addedToday}")`;
  const [phase, setPhase] = useState<Phase>('intake');
  const [resume, setResume] = useState<ResumeState>({ status: 'ready' });

  const [fields, setFields] = useState<IntakeState>(emptyIntakeState);
  const [provenance, setProvenance] = useState<ProvenanceMap>({});
  // Governed-LLM extraction warning (non-blocking) — set when the tenant is on
  // governed_llm and the LLM could not run/produce (§15).
  const [parseWarning, setParseWarning] = useState<string | null>(null);
  // Reviewable work-history (governed_llm) — extracted 'from résumé', recruiter-
  // editable, persisted at create as TalentWorkHistoryEntry (source='resume').
  const [workHistory, setWorkHistory] = useState<WorkHistoryDraft[]>([]);
  // HF1 Gate-6 — structured skills + source_refs and the corpus provenance
  // carried from the draft into the create request (durable evidence provenance;
  // the free-text key_skills field remains the recruiter-facing surface).
  const [resumeSkills, setResumeSkills] = useState<readonly SkillDraft[]>([]);
  // HF2 R8/R18/R19 — grounded education + certifications carried from the draft
  // into the create request (persisted at create as declared evidence).
  const [resumeEducation, setResumeEducation] = useState<readonly EducationDraft[]>([]);
  const [resumeCertifications, setResumeCertifications] = useState<
    readonly CertificationDraft[]
  >([]);
  const [resumeProvenance, setResumeProvenance] = useState<{
    source_map_version?: string;
    resume_text_hash?: string;
  }>({});

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attachWarning, setAttachWarning] = useState<string | null>(null);
  // Delta-2 — the "Possible existing Talent" card. Populated PROACTIVELY: the
  // effect below checks the entered/parsed primary email against the tenant's
  // live records (email1 is the authoritative dedup anchor) BEFORE Create is
  // pressed, and Create is blocked while a match stands. The create-time 409
  // TALENT_RECORD_DUPLICATE remains the hard backstop for the check→create
  // race. A TalentRecord can never be duplicated on primary email.
  const [duplicate, setDuplicate] = useState<TalentDuplicateMatch | null>(null);
  const [created, setCreated] = useState<TalentRecordView | null>(null);

  const beginTimer = useCallback(() => {
    setStartedAt((prev) => prev ?? Date.now());
  }, []);

  // Proactive duplicate check — debounced on the primary email. Fires whenever
  // the email is a valid shape (after parse prefills it AND on manual entry);
  // clears the card when the email is empty/invalid or no longer collides.
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
          // Network/permission failure — never block create on a check error;
          // the create-time 409 is the authoritative backstop.
          if (!cancelled) setDuplicate(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email1]);

  // ── Field editing ──────────────────────────────────────────────────────
  function onField(key: keyof IntakeState, value: string): void {
    setFields((s) => ({ ...s, [key]: value }));
    setProvenance((p) => {
      const next = provenanceAfterEdit(p[key as string] as Provenance | undefined);
      if (next === p[key as string]) return p;
      const updated = { ...p };
      if (next === undefined) delete updated[key as string];
      else updated[key as string] = next;
      return updated;
    });
  }
  function onToggle(key: 'can_relocate' | 'is_hot'): void {
    setFields((s) => ({ ...s, [key]: !s[key] }));
  }
  // Work-history review-card editing (recruiter corrects the extracted rows).
  function onWorkHistoryField(index: number, key: keyof WorkHistoryDraft, value: string): void {
    setWorkHistory((prev) =>
      prev.map((e, i) => (i === index ? { ...e, [key]: value } : e)),
    );
  }
  function onAddWorkHistory(): void {
    setWorkHistory((prev) => [...prev, { employer_name: '', role_title: '' }]);
  }
  function onRemoveWorkHistory(index: number): void {
    setWorkHistory((prev) => prev.filter((_, i) => i !== index));
  }

  // ── Resume flow (the real 3-step) ───────────────────────────────────────
  async function handleFile(file: File): Promise<void> {
    beginTimer();
    setPhase('parsing');
    setParseWarning(null);
    setResume({ status: 'uploading', file });
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;

    let storage_key: string;
    let presigned_url: string;
    try {
      const presign = await requestResumeUploadUrl({
        filename: file.name,
        content_type: contentType,
      });
      storage_key = presign.storage_key;
      presigned_url = presign.presigned_url;
    } catch (err) {
      // Upload-url failed before any S3 object exists. A resume is REQUIRED to
      // create a talent (no manual-entry fallback), so stay on the intake
      // screen with the error surfaced for retry.
      setResume({ status: 'error', file, error: uploadErrorMessage(err) });
      setPhase('intake');
      return;
    }

    try {
      await putResumeToStorage(presigned_url, file, contentType);
    } catch (err) {
      // The presigned PUT failed: no committed object. Resume is required, so
      // stay on intake with the error for retry (no manual-entry fallback).
      setResume({ status: 'error', file, error: uploadErrorMessage(err) });
      setPhase('intake');
      return;
    }

    setResume({ status: 'parsing', file, storage_key });
    try {
      const result = await parseDraftFromResume({ storage_key });
      const applied = applyPrefill(emptyIntakeState(), result.prefill, result.mode);
      setFields(applied.state);
      setProvenance(applied.provenance);
      setWorkHistory(result.work_history ? [...result.work_history] : []);
      // HF1 — carry structured skills + corpus provenance for durable evidence
      // persistence at create (the free-text key_skills field is set via prefill).
      setResumeSkills(result.skills ? [...result.skills] : []);
      setResumeEducation(result.education ? [...result.education] : []);
      setResumeCertifications(result.certifications ? [...result.certifications] : []);
      setResumeProvenance({
        source_map_version: result.source_map_version,
        resume_text_hash: result.resume_text_hash,
      });
      // Governed-mode warning (LLM unavailable / unreadable / zero fields) is
      // NON-BLOCKING (§15): the form opens for review + manual entry; the
      // recruiter can go Back and re-upload to retry. No silent mode fallback.
      setParseWarning(result.warning ?? null);
      setResume({ status: 'ready', file, storage_key });
    } catch (err) {
      // Parse network failure (the BE never throws on parse FAILURE — a
      // 'failed' status is a normal 200). The file IS uploaded; keep the
      // storage_key so attach-on-create still fires (ruling 3).
      setResume({ status: 'error', file, storage_key, error: uploadErrorMessage(err) });
    }
    setPhase('form');
  }

  function resetAll(): void {
    setPhase('intake');
    setResume({ status: 'ready' });
    setFields(emptyIntakeState());
    setProvenance({});
    setParseWarning(null);
    setWorkHistory([]);
    setResumeSkills([]);
    setResumeEducation([]);
    setResumeCertifications([]);
    setResumeProvenance({});
    setStartedAt(null);
    setElapsedMs(0);
    setSubmitting(false);
    setSubmitError(null);
    setAttachWarning(null);
    setDuplicate(null);
    setCreated(null);
  }

  // ── Save gate ───────────────────────────────────────────────────────────
  // Manual-create required set (PO-agreed). FE validation only — the DB stays
  // nullable so externally-sourced / staged records are unaffected. Work
  // authorization requires a CHOICE (NOT_DISCLOSED is a valid explicit value).
  const nameOk = fields.first_name.trim() !== '' && fields.last_name.trim() !== '';
  const emailOk = /\S+@\S+\.\S+/.test(fields.email1.trim());
  const phoneOk = fields.phone_cell.trim() !== '';
  const cityOk = fields.city.trim() !== '';
  const stateOk = fields.state.trim() !== '';
  // Work authorization + desired rate are OPTIONAL (PO ruling): the résumé often
  // does not state them, and they are captured later on the Talent record. They
  // are NOT part of the create gate or the required checklist.
  const resumeOk = resume.storage_key !== undefined;
  const canCreate =
    nameOk &&
    emailOk &&
    phoneOk &&
    cityOk &&
    stateOk &&
    resumeOk &&
    duplicate === null &&
    !submitting;

  async function onCreate(): Promise<void> {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    setAttachWarning(null);

    // HF1 Gate-6 — the résumé document + corpus provenance, carried into the
    // create request so the BE creates the résumé TalentDocument AFTER confirmed
    // creation and stamps durable provenance onto the persisted evidence.
    const resumeDocument =
      resume.file !== undefined && resume.storage_key !== undefined
        ? {
            storage_key: resume.storage_key,
            file_name: resume.file.name,
            mime_type: resume.file.type === '' ? 'application/octet-stream' : resume.file.type,
            size_bytes: resume.file.size,
            source_map_version: resumeProvenance.source_map_version,
            resume_text_hash: resumeProvenance.resume_text_hash,
          }
        : undefined;

    let record: TalentRecordView;
    try {
      record = await createTalent(
        buildCreateBody(fields, workHistory, {
          skills: resumeSkills,
          resumeDocument,
          education: resumeEducation,
          certifications: resumeCertifications,
        }),
      );
    } catch (err) {
      // Backstop: the proactive check should already show the card + block
      // Create, but a record can appear between check and create. On the 409
      // re-fetch the existing record's display fields (accurate WHO) so the
      // card surfaces rather than a generic error — never a silent merge.
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
      } else {
        setSubmitError(createErrorMessage(err));
      }
      setSubmitting(false);
      return;
    }

    // Ruling 3: attach in ALL parse branches whenever the upload produced a
    // storage_key (even an errored parse). Soft-fail — the talent IS created.
    if (resume.file !== undefined && resume.storage_key !== undefined) {
      try {
        await createAttachment({
          owner_type: 'talent',
          owner_id: record.id,
          file_name: resume.file.name,
          mime: resume.file.type === '' ? 'application/octet-stream' : resume.file.type,
          size_bytes: resume.file.size,
          storage_key: resume.storage_key,
          is_resume: true,
        });
      } catch (err) {
        setAttachWarning(attachErrorMessage(err));
      }
    }

    if (startedAt !== null) setElapsedMs(Date.now() - startedAt);
    setCreated(record);
    setSubmitting(false);
    setPhase('success');
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (phase === 'success' && created !== null) {
    return (
      <SuccessScreen
        name={`${created.first_name} ${created.last_name}`}
        elapsedMs={elapsedMs}
        attachWarning={attachWarning}
        onOpen={() => navigate(`/talent/${created.id}`)}
        onAnother={resetAll}
      />
    );
  }

  return (
    <section className="rc-addtalent">
      <PageHeader title="Add talent" description={headerDescription} />

      {phase === 'intake' ? (
        <div className="rc-stepwrap">
          <div className="rc-stepintro">
            <div className="rc-stepeyebrow">Step 1 of 2 · Source</div>
            <h2 className="rc-steptitle">Start with the resume</h2>
            <p className="rc-stepdesc">
              Aramo parses it, runs the identity check, and proposes values for
              your review — nothing is created until you confirm.
            </p>
          </div>
          <ResumeDropzone onFile={handleFile} />
          <p className="rc-stepreq">
            A resume is required to create a Talent record.
          </p>
          <div className="rc-stepcancel">
            <button
              type="button"
              className="rc-btn"
              onClick={() => navigate('/talent')}
            >
              Cancel
            </button>
            <p className="rc-stepcancel__note">
              Contact permissions are governed separately from profile creation ·
              provenance is recorded automatically.
            </p>
          </div>
        </div>
      ) : null}

      {phase === 'parsing' && resume.file !== undefined ? (
        <ParseProgress
          phase={resume.status === 'uploading' ? 'uploading' : 'parsing'}
          fileName={resume.file.name}
        />
      ) : null}

      {phase === 'form' ? (
        <div className="rc-editgrid">
          <div className="rc-editgrid__main">
            <div className="rc-stephdr">
              <button
                type="button"
                className="rc-step__back"
                disabled={submitting}
                onClick={() => setPhase('intake')}
              >
                ← Back
              </button>
              <span className="rc-stepeyebrow">Step 2 of 2 · Review &amp; create</span>
            </div>
            <ParseBanner resume={resume} />
            {parseWarning !== null ? (
              <div className="rc-warnnote" role="status">
                {parseWarning}
              </div>
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
              education={resumeEducation}
              certifications={resumeCertifications}
              disabled={submitting}
              onField={onField}
              onToggle={onToggle}
              onWorkHistoryField={onWorkHistoryField}
              onAddWorkHistory={onAddWorkHistory}
              onRemoveWorkHistory={onRemoveWorkHistory}
            />
          </div>

          <aside className="rc-editgrid__rail">
            {/* The form phase is reached only after a resume upload committed
                (resume is required), so the attached-resume card always shows. */}
            {resume.file !== undefined ? (
              <ResumeCard fileName={resume.file.name} sizeBytes={resume.file.size} />
            ) : null}

            <RequirementList
              gates={[
                { ok: nameOk, label: 'First and last name' },
                { ok: emailOk, label: 'Email address' },
                { ok: phoneOk, label: 'Phone number' },
                { ok: cityOk && stateOk, label: 'City and state' },
                { ok: resumeOk, label: 'Resume attached' },
              ]}
            />
            <p className="rc-secnote">
              Work authorization and desired rate are optional — capture them
              later if the résumé doesn’t state them.
            </p>
            {/* Résumé preview alongside the form so the recruiter can check the
                proposed values against the source while reviewing. Rendered from
                the file already in memory (no server round-trip). */}
            {resume.file !== undefined ? <ResumePreview file={resume.file} /> : null}
          </aside>
        </div>
      ) : null}

      {/* Step-2 footer — the create/cancel action bar. Step 1 carries its own
          centered Cancel + note under the dropzone (no action bar there, since
          nothing can be created until the form is reached). */}
      {phase === 'form' ? (
        <div className="rc-addfoot">
          <div className="rc-addfoot__actions">
            <button
              type="button"
              className="rc-btn rc-btn--primary"
              disabled={!canCreate || submitting}
              onClick={onCreate}
            >
              <Icons.IconCheck />
              {submitting ? 'Creating…' : 'Create talent'}
            </button>
            <button
              type="button"
              className="rc-btn"
              disabled={submitting}
              onClick={() => navigate('/talent')}
            >
              Cancel
            </button>
          </div>
          <p className="rc-addfoot__note">
            Contact permissions are governed separately from profile creation ·
            provenance is recorded automatically.
          </p>
        </div>
      ) : null}
    </section>
  );
}

// ── Parse banner ───────────────────────────────────────────────────────────
function ParseBanner({ resume }: { readonly resume: ResumeState }) {
  if (resume.status === 'error') {
    return (
      <InlineAlert variant="error">
        We couldn’t auto-read this resume — review and complete the fields
        below; the resume is attached and saved with the record.
      </InlineAlert>
    );
  }
  if (resume.file !== undefined && resume.storage_key !== undefined) {
    return (
      <div className="rc-parsedpill">
        <Icons.IconCheck />
        <span>
          Parsed from {resume.file.name} — review the proposed values below.
        </span>
      </div>
    );
  }
  return null;
}

// ── Duplicate-match card (Delta 2) ───────────────────────────────────────────
// Shown when the create is refused with 409 TALENT_RECORD_DUPLICATE — the
// admission-invariant dedup found an active talent in the tenant with this
// primary email. NEVER a silent merge: the recruiter reviews the existing
// record or uses a different email. (The prototype's "Continue — different
// person" does not apply to an EXACT-email match — the server enforces primary
// email uniqueness — so the second action changes the email instead.)
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
  // The existing record's context line: title · city, state (whatever is set).
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
          <button
            type="button"
            className="rc-dupcard__review"
            onClick={() => onReview(match.id)}
          >
            Review existing Talent
          </button>
          <button type="button" className="rc-dupcard__diff" onClick={onDifferent}>
            Use a different email
          </button>
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
            {Math.max(1, Math.round(sizeBytes / 1024))} KB · attaches on save
          </div>
        </div>
      </div>
      <p className="rc-consent__note">
        <Icons.IconShield />
        <span>
          SSN-shaped patterns are redacted before the resume text is stored
          (D4). Resume text purges on delete (ADR-0015 cascade).
        </span>
      </p>
    </section>
  );
}

// ── Résumé preview ───────────────────────────────────────────────────────────
// Renders the attached résumé alongside the review form so the recruiter can
// cross-check the proposed values against the source. Uses the selected File
// already in memory (object URL) — no server round-trip, no presigned URL.
// PDFs render inline; other types (e.g. .docx, which browsers can't render
// natively) show a note (the file still saves with the record).
function ResumePreview({ file }: { readonly file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  // Close the full-screen overlay on Escape.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const ext = file.name.split('.').pop()?.toUpperCase() ?? 'file';
  return (
    <section className="rc-sidecard rc-rpreview" aria-label="Résumé preview">
      <div className="rc-rpreview__hdrow">
        <h3 className="rc-sidecard__h">
          <Icons.IconFile />
          Résumé preview
        </h3>
        {url !== null && isPdf ? (
          <button
            type="button"
            className="rc-rpreview__expand"
            onClick={() => setExpanded(true)}
          >
            Expand
          </button>
        ) : null}
      </div>
      {url !== null && isPdf ? (
        <iframe className="rc-rpreview__frame" title="Résumé preview" src={url} />
      ) : (
        <p className="rc-secnote">
          Inline preview isn’t available for a .{ext.toLowerCase()} file — the
          attached résumé is saved with the record.
        </p>
      )}
      {expanded && url !== null ? (
        <div
          className="rc-rpreview__overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Résumé full preview"
        >
          <div className="rc-rpreview__ovbar">
            <span className="rc-rpreview__ovtitle">{file.name}</span>
            <button
              type="button"
              className="rc-rpreview__ovclose"
              onClick={() => setExpanded(false)}
            >
              Close
            </button>
          </div>
          <iframe className="rc-rpreview__ovframe" title="Résumé full preview" src={url} />
        </div>
      ) : null}
    </section>
  );
}

// ── Requirement checklist ────────────────────────────────────────────────────
// The rail-side "what's still needed to create" list. The Create / Cancel
// actions live in the persistent footer (rc-addfoot), so this component is a
// read-only checklist mirroring the footer's disabled state.
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
  elapsedMs,
  attachWarning,
  onOpen,
  onAnother,
}: {
  readonly name: string;
  readonly elapsedMs: number;
  readonly attachWarning: string | null;
  readonly onOpen: () => void;
  readonly onAnother: () => void;
}) {
  return (
    <section className="rc-success">
      <div className="rc-success__ic" aria-hidden="true">
        <Icons.IconCheck />
      </div>
      <h2>{name} added to your talent</h2>
      <p>Profile created, resume attached and queued for indexing.</p>
      {elapsedMs > 0 ? (
        <div className="rc-success__big mono">{(elapsedMs / 1000).toFixed(1)}s</div>
      ) : null}
      {attachWarning !== null ? (
        <InlineAlert variant="error">{attachWarning}</InlineAlert>
      ) : null}
      <div className="rc-success__btns">
        <button type="button" className="rc-btn rc-btn--primary" onClick={onOpen}>
          Open profile
        </button>
        <button type="button" className="rc-btn" onClick={onAnother}>
          Add another
        </button>
      </div>
    </section>
  );
}
