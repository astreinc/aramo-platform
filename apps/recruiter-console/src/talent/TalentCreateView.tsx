import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AttestCheckbox, Icons, InlineAlert, PageHeader, ReservedSeam } from '../ui';

import { ResumeDropzone } from './ResumeDropzone';
import { ParseProgress } from './ParseProgress';
import { IntakeForm } from './IntakeForm';
import { ConsentCapture } from './ConsentCapture';
import {
  createAttachment,
  createTalent,
  parseDraftFromResume,
  putResumeToStorage,
  requestResumeUploadUrl,
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
import {
  defaultConsentState,
  requiredConsentGranted,
  type ConsentScope,
  type ConsentState,
} from './consent';
import type { Provenance, ProvenanceMap } from './provenance';
import type { TalentRecordView } from './types';

// R5 (rebuild) — the Add-Talent surface, rebuilt to enterprise-mockup parity.
//
// Phases: intake (dropzone) → parsing (real upload + parse) → form (two-column
// edit + right rail) → success. Manual entry skips straight to the form.
//
// WIRED (real backend, no mock):
//   • Résumé S3 flow: presign PUT → direct-to-S3 PUT → deterministic parse
//     (stated facts only, no-LLM per ADR-0015) → create → attach (auto-clears
//     the orphan-pending tag). Attach fires in ALL parse branches; attach is
//     soft-fail (talent is still created).
//   • Provenance chips: REAL signal only (résumé / edited).
//   • Consent capture: the real 5-scope model + attestation gate the save.
//
// SEAMS (no backend → no fabrication):
//   • Duplicate detection — ReservedSeam ("coming soon"). No dedup endpoint.
//   • Work history & education — ReservedSeam (IntakeForm). No parse, no store.
//   • Match insight — already a ReservedSeam in the design system (R10).
//
// DEFERRED (Lead HALT — keying carry):
//   • POST /v1/consent/grant is NOT fired. The grant keys on a Core talent_id
//     a new ATS record lacks at create; minting one at ATS-create would break
//     the locked LINK-NOT-CREATE invariant. Consent is captured + gates the
//     save; the grant goes live once the Core-creation seam exists. See
//     doc/go-live-known-limitations.md + ./consent.ts.

type Phase = 'intake' | 'parsing' | 'form' | 'success';

interface ResumeState {
  readonly status: 'uploading' | 'parsing' | 'ready' | 'error';
  readonly file?: File;
  readonly storage_key?: string;
  readonly error?: string;
}

const ATTEST_TEXT =
  'I attest that consent to represent this person has been obtained and recorded. Manual add is an audited exception.';

export function TalentCreateView() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('intake');
  const [resume, setResume] = useState<ResumeState>({ status: 'ready' });

  const [fields, setFields] = useState<IntakeState>(emptyIntakeState);
  const [provenance, setProvenance] = useState<ProvenanceMap>({});
  const [skills, setSkills] = useState<string[]>([]);
  const [skillsFromResume, setSkillsFromResume] = useState(false);

  const [consent, setConsent] = useState<ConsentState>(defaultConsentState);
  const [attested, setAttested] = useState(false);

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attachWarning, setAttachWarning] = useState<string | null>(null);
  const [created, setCreated] = useState<TalentRecordView | null>(null);

  const beginTimer = useCallback(() => {
    setStartedAt((prev) => prev ?? Date.now());
  }, []);

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
  function onAddSkill(skill: string): void {
    setSkills((prev) => (prev.includes(skill) ? prev : [...prev, skill]));
  }
  function onRemoveSkill(index: number): void {
    setSkills((prev) => prev.filter((_, i) => i !== index));
  }
  function onConsentToggle(scope: ConsentScope): void {
    setConsent((c) => ({ ...c, [scope]: !c[scope] }));
  }

  // ── Résumé flow (the real 3-step) ───────────────────────────────────────
  async function handleFile(file: File): Promise<void> {
    beginTimer();
    setPhase('parsing');
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
      // Upload-url failed before any S3 object exists — drop to the manual
      // form with a note; no storage_key, so nothing attaches.
      setResume({ status: 'error', file, error: uploadErrorMessage(err) });
      setPhase('form');
      return;
    }

    try {
      await putResumeToStorage(presigned_url, file, contentType);
    } catch (err) {
      // The presigned PUT failed: no committed object. Manual form, no attach.
      setResume({ status: 'error', file, error: uploadErrorMessage(err) });
      setPhase('form');
      return;
    }

    setResume({ status: 'parsing', file, storage_key });
    try {
      const result = await parseDraftFromResume({ storage_key });
      const applied = applyPrefill(emptyIntakeState(), result.prefill);
      setFields(applied.state);
      setProvenance(applied.provenance);
      setSkills(applied.skills);
      setSkillsFromResume(applied.skillsFromResume);
      setResume({ status: 'ready', file, storage_key });
    } catch (err) {
      // Parse network failure (the BE never throws on parse FAILURE — a
      // 'failed' status is a normal 200). The file IS uploaded; keep the
      // storage_key so attach-on-create still fires (ruling 3).
      setResume({ status: 'error', file, storage_key, error: uploadErrorMessage(err) });
    }
    setPhase('form');
  }

  function startManual(): void {
    beginTimer();
    setResume({ status: 'ready' });
    setPhase('form');
  }

  function resetAll(): void {
    setPhase('intake');
    setResume({ status: 'ready' });
    setFields(emptyIntakeState());
    setProvenance({});
    setSkills([]);
    setSkillsFromResume(false);
    setConsent(defaultConsentState());
    setAttested(false);
    setStartedAt(null);
    setElapsedMs(0);
    setSubmitting(false);
    setSubmitError(null);
    setAttachWarning(null);
    setCreated(null);
  }

  // ── Save gate ───────────────────────────────────────────────────────────
  const nameOk = fields.first_name.trim() !== '' && fields.last_name.trim() !== '';
  const consentOk = requiredConsentGranted(consent);
  const canCreate = nameOk && consentOk && attested && !submitting;

  async function onCreate(): Promise<void> {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    setAttachWarning(null);

    let record: TalentRecordView;
    try {
      record = await createTalent(buildCreateBody(fields, skills));
    } catch (err) {
      setSubmitError(createErrorMessage(err));
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

    // Consent grant is DEFERRED (keying HALT) — NOT fired here. See consent.ts.

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
      <PageHeader
        title="New talent"
        description="Add a person to your shared tenant talent pool — drop a résumé and review, or enter details manually."
      />

      {phase === 'intake' ? (
        <ResumeDropzone onFile={handleFile} onManual={startManual} />
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
            <ParseBanner resume={resume} skillsFromResume={skillsFromResume} />
            {submitError !== null ? (
              <InlineAlert variant="error">{submitError}</InlineAlert>
            ) : null}
            <IntakeForm
              values={fields}
              provenance={provenance}
              skills={skills}
              skillsFromResume={skillsFromResume}
              disabled={submitting}
              onField={onField}
              onToggle={onToggle}
              onAddSkill={onAddSkill}
              onRemoveSkill={onRemoveSkill}
            />
          </div>

          <aside className="rc-editgrid__rail">
            {resume.file !== undefined && resume.storage_key !== undefined ? (
              <ResumeCard fileName={resume.file.name} sizeBytes={resume.file.size} />
            ) : null}

            <ReservedSeam title="Duplicate check" tag="Coming soon">
              Aramo surfaces likely-duplicate people for you to decide — it never
              silently merges. Duplicate detection arrives soon.
            </ReservedSeam>

            <ConsentCapture
              value={consent}
              onToggle={onConsentToggle}
              disabled={submitting}
            />

            <section className="rc-sidecard rc-attestcard" aria-label="Attestation">
              <h3 className="rc-sidecard__h">
                <Icons.IconShield />
                Attestation
              </h3>
              <AttestCheckbox
                checked={attested}
                onChange={setAttested}
                disabled={submitting}
              >
                {ATTEST_TEXT}
              </AttestCheckbox>
            </section>

            <SaveBar
              nameOk={nameOk}
              consentOk={consentOk}
              attested={attested}
              canCreate={canCreate}
              submitting={submitting}
              onCreate={onCreate}
              onCancel={() => navigate('/talent')}
            />
          </aside>
        </div>
      ) : null}
    </section>
  );
}

// ── Parse banner ───────────────────────────────────────────────────────────
function ParseBanner({
  resume,
  skillsFromResume,
}: {
  readonly resume: ResumeState;
  readonly skillsFromResume: boolean;
}) {
  if (resume.status === 'error') {
    return (
      <InlineAlert variant="error">
        We couldn’t read this résumé
        {resume.storage_key !== undefined
          ? ' — enter the details manually; the file will still be attached when you save.'
          : '. Enter the details manually.'}
      </InlineAlert>
    );
  }
  if (resume.file !== undefined && resume.storage_key !== undefined) {
    return (
      <InlineAlert variant="success">
        Parsed the stated facts from the résumé{skillsFromResume ? ' (including skills)' : ''}.
        Review anything flagged, complete the required fields, then create.
      </InlineAlert>
    );
  }
  return (
    <p className="rc-addtalent__hint">
      <Icons.IconInfo />
      Manual entry. Tip: dropping a résumé auto-fills name, contact, location and
      skills from the stated facts.
    </p>
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
            {Math.max(1, Math.round(sizeBytes / 1024))} KB · attaches on save
          </div>
        </div>
      </div>
      <p className="rc-consent__note">
        <Icons.IconShield />
        <span>
          SSN-shaped patterns are redacted before the résumé text is stored
          (D4). Résumé text purges on delete (ADR-0015 cascade).
        </span>
      </p>
    </section>
  );
}

// ── Save-gate bar ────────────────────────────────────────────────────────────
function SaveBar({
  nameOk,
  consentOk,
  attested,
  canCreate,
  submitting,
  onCreate,
  onCancel,
}: {
  readonly nameOk: boolean;
  readonly consentOk: boolean;
  readonly attested: boolean;
  readonly canCreate: boolean;
  readonly submitting: boolean;
  readonly onCreate: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <section className="rc-savebar">
      <ul className="rc-savebar__gates">
        <GateRow ok={nameOk} label="First and last name" />
        <GateRow ok={consentOk} label="Required consent captured" />
        <GateRow ok={attested} label="Attestation signed" />
      </ul>
      <button
        type="button"
        className="rc-btn rc-btn--primary"
        disabled={!canCreate}
        onClick={onCreate}
      >
        <Icons.IconCheck />
        {submitting ? 'Creating…' : 'Create talent'}
      </button>
      <button
        type="button"
        className="rc-btn rc-btn--ghost"
        disabled={submitting}
        onClick={onCancel}
      >
        Cancel
      </button>
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
      <p>Profile created, résumé attached and queued for indexing, consent recorded with the record.</p>
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
