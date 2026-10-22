import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogClose } from '@aramo/fe-foundation';

import {
  getPipelineResumeEdition,
  setPipelineResumeEdition,
} from '../pipeline/pipeline-api';
import {
  createAttachment,
  createTalentResumeEdition,
  getTalentResumeEditionText,
  putResumeToStorage,
  requestResumeUploadUrl,
} from '../talent/talent-api';
import { LoadingState, StatusPill } from '../ui';
import type {
  PipelineResumeEditionAvailable,
  PipelineResumeEditionView,
} from '../pipeline/types';

// TI-1D-D — the Requisition-context resume selection surface, inside the
// requisition's Talent detail drawer. It distinguishes THREE things the recruiter
// must never conflate:
//   1. the EXPLICIT working selection for THIS requisition (Layer A truth);
//   2. the Talent-global default — a SUGGESTION only, shown when nothing is
//      selected yet, and NEVER auto-bound;
//   3. the editions available to newly select.
// PREVIEW never binds: opening a resume to read it is inert — only the explicit
// "Use this resume" button issues the governed PUT (pipeline:resume:set). The
// send-time freeze is a separate step owned by the submittal surface.
export interface ResumeSelectionSectionProps {
  readonly pipelineId: string;
  // scopes.includes('pipeline:resume:set') — gates the mutating affordance only.
  readonly canSetSelection: boolean;
  // The Talent the pipeline belongs to — the owner of uploaded tailored editions
  // and of the edition-text preview read. Defaults to the authoritative
  // talent_record_id the pipeline resume-edition read returns.
  readonly talentId?: string;
  // talent:edit + attachment:create — gates "Upload tailored resume". Uploading
  // only ADDS an edition tailored for this requisition; it never selects it (the
  // explicit "Use this resume" stays the only binding action).
  readonly canUploadTailored?: boolean;
}

const RESUME_ACCEPT = '.pdf,.doc,.docx,application/pdf';

export function ResumeSelectionSection({
  pipelineId,
  canSetSelection,
  talentId,
  canUploadTailored = false,
}: ResumeSelectionSectionProps): JSX.Element {
  const [view, setView] = useState<PipelineResumeEditionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPipelineResumeEdition(pipelineId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setErr('Resume selection is unavailable for this talent.');
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId]);

  // Explicit selection ONLY — the PUT appends a new working-selection row. On
  // success we re-read the authoritative state (never an optimistic FE guess).
  const handleUse = (editionId: string): void => {
    setBusyId(editionId);
    setErr(null);
    void setPipelineResumeEdition(pipelineId, { resume_edition_id: editionId })
      .then(() => getPipelineResumeEdition(pipelineId))
      .then((v) => setView(v))
      .catch(() => setErr('Could not set the resume — the backend rejected this.'))
      .finally(() => setBusyId(null));
  };

  // Upload a NEW edition tailored for this requisition (purpose REQUISITION,
  // derived from the current working selection or the default). The existing
  // governed path: presigned PUT → owned resume attachment → edition ingestion.
  // It does NOT select the new edition — the recruiter chooses it explicitly.
  const handleUpload = (file: File | undefined): void => {
    const owner = talentId ?? view?.talent_record_id;
    if (file === undefined || view === null || owner === undefined) return;
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    const derivedFrom = view.selected_edition_id ?? view.default_edition_id ?? undefined;
    setUploading(true);
    setErr(null);
    setNotice(null);
    void requestResumeUploadUrl({ filename: file.name, content_type: contentType })
      .then((presign) =>
        putResumeToStorage(presign.presigned_url, file, contentType).then(() =>
          createAttachment({
            owner_type: 'talent',
            owner_id: owner,
            file_name: file.name,
            mime: contentType,
            size_bytes: file.size,
            storage_key: presign.storage_key,
            is_resume: true,
          }),
        ),
      )
      .then((att) =>
        createTalentResumeEdition(owner, {
          attachment_id: att.id,
          purpose: 'REQUISITION',
          requisition_id: view.requisition_id,
          ...(derivedFrom !== undefined ? { derived_from_edition_id: derivedFrom } : {}),
        }),
      )
      .then(() => getPipelineResumeEdition(pipelineId))
      .then((v) => {
        setView(v);
        setNotice('Tailored resume added — choose “Use this resume” to select it for this requisition.');
      })
      .catch(() => setErr('Could not upload the tailored resume. Please try again.'))
      .finally(() => {
        setUploading(false);
        if (fileRef.current !== null) fileRef.current.value = '';
      });
  };

  if (view === null) {
    return (
      <section className="rc-cdp__sec" data-testid="resume-selection">
        <div className="rc-cdp__seclabel">Resume — this position</div>
        <p className="rc-cdp__note">{err ?? 'Loading resume selection…'}</p>
      </section>
    );
  }

  // Defensive: a degenerate payload must never hard-crash the whole drawer
  // subtree — an absent/non-array editions list degrades to "no editions".
  const editions: readonly PipelineResumeEditionAvailable[] = Array.isArray(
    view.available_editions,
  )
    ? view.available_editions
    : [];
  const selectedId = view.selected_edition_id ?? null;
  const defaultId = view.default_edition_id ?? null;
  const selected =
    selectedId === null
      ? null
      : editions.find((e) => e.edition_id === selectedId) ?? null;
  const defaultEdition =
    defaultId === null
      ? null
      : editions.find((e) => e.edition_id === defaultId) ?? null;
  // Resume Revision Lifecycle §9 — the selected revision was archived after it was
  // selected (so it is absent from the active-only available list). The system does
  // NOT silently switch to another revision; it asks the recruiter to replace it.
  // This is the UX projection of the SAME rule the backend submit guard enforces.
  const requiresAttention = view.selected_requires_attention === true;
  const ownerTalentId = talentId ?? view.talent_record_id;

  return (
    <section className="rc-cdp__sec" data-testid="resume-selection">
      <div className="rc-cdp__seclabel">Resume — this position</div>

      {requiresAttention ? (
        <p className="rc-cdp__err" data-testid="resume-requires-attention">
          {/* ATS-QA-1 D14 — the copy names the control only when the viewer has it. */}
          {canSetSelection
            ? 'Resume requires attention — the selected resume has been archived. Choose “Use this resume” on an active resume below before submitting to the client.'
            : 'Resume requires attention — the selected resume has been archived. An active resume must be chosen before submitting to the client.'}
        </p>
      ) : selected !== null ? (
        <p className="rc-cdp__note" data-testid="resume-current-selection">
          Selected for this requisition: <strong>{selected.filename}</strong>
          {selected.revision_number !== null ? (
            <> — Revision {selected.revision_number}</>
          ) : null}
        </p>
      ) : defaultEdition !== null ? (
        // The default is a SUGGESTION only — explicitly labelled, never bound.
        <p className="rc-cdp__note" data-testid="resume-default-suggestion">
          No resume selected yet. Suggested default:{' '}
          <strong>{defaultEdition.filename}</strong>
          {/* ATS-QA-1 D14 — "select one below" named a control that was not there. */}
          {canSetSelection
            ? ' — choose “Use this resume” below to use it for this requisition.'
            : '.'}
        </p>
      ) : (
        <p className="rc-cdp__note">No resume selected yet.</p>
      )}

      {err !== null ? <p className="rc-cdp__err">{err}</p> : null}
      {notice !== null ? (
        <p className="rc-cdp__note" role="status" data-testid="resume-upload-notice">
          {notice}
        </p>
      ) : null}

      <ul className="rc-cdp__resumes">
        {editions.map((e) => (
          <ResumeRow
            key={e.edition_id}
            edition={e}
            currentRequisitionId={view.requisition_id}
            isSelected={e.edition_id === selectedId}
            canSetSelection={canSetSelection}
            canPreview
            busy={busyId === e.edition_id}
            onUse={() => handleUse(e.edition_id)}
            onPreview={() => setPreviewId(e.edition_id)}
          />
        ))}
      </ul>

      {canUploadTailored ? (
        <div className="rc-cdp__resumeupload">
          {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native file picker — distinct native behavior, no fe-foundation primitive */}
          <input
            ref={fileRef}
            type="file"
            accept={RESUME_ACCEPT}
            hidden
            data-testid="resume-tailored-input"
            onChange={(e) => handleUpload(e.target.files?.[0])}
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            data-testid="resume-upload-tailored"
          >
            {uploading ? 'Uploading…' : 'Upload tailored resume'}
          </Button>
          <span className="rc-cdp__note">PDF or Word · saved as a new revision tailored for this requisition</span>
        </div>
      ) : null}

      {previewId !== null ? (
        <ResumeTextPreview
          talentId={ownerTalentId}
          edition={editions.find((e) => e.edition_id === previewId) ?? null}
          editionId={previewId}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </section>
  );
}

// PREVIEW is inert (never binds, issues no PUT): it reads the edition's OWN
// redacted text (TI-1H §9 — opening edition R returns R's text, never another's).
function ResumeTextPreview({
  talentId,
  edition,
  editionId,
  onClose,
}: {
  readonly talentId: string;
  readonly edition: PipelineResumeEditionAvailable | null;
  readonly editionId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'pending' | 'error'>('loading');
  useEffect(() => {
    let cancelled = false;
    void getTalentResumeEditionText(talentId, editionId)
      .then((v) => {
        if (cancelled) return;
        if (v.redacted_text === null || v.redacted_text.trim() === '') {
          setState('pending');
        } else {
          setText(v.redacted_text);
          setState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [talentId, editionId]);
  const name = edition?.filename ?? 'Resume';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={<span className="rc-cdp__pvtitle">{name}</span>}
      description={
        edition !== null && edition.revision_number !== null
          ? `Revision ${edition.revision_number} · contact details redacted`
          : 'Contact details redacted'
      }
      size="lg"
    >
      <DialogClose asChild>
        <Button unstyled type="button" className="rc-cdp__pvclose" aria-label="Close resume preview">
          ×
        </Button>
      </DialogClose>
      {state === 'loading' ? <LoadingState label="Loading resume…" /> : null}
      {state === 'pending' ? (
        <p className="rc-cdp__note">The text for this revision is still being extracted. Try again in a minute.</p>
      ) : null}
      {state === 'error' ? <p className="rc-cdp__err">This resume could not be loaded.</p> : null}
      {state === 'ready' && text !== null ? (
        <div className="rc-cdp__pvtext" data-testid="resume-preview-text">
          {text}
        </div>
      ) : null}
    </Dialog>
  );
}

function ResumeRow({
  edition,
  currentRequisitionId,
  isSelected,
  canSetSelection,
  canPreview,
  busy,
  onUse,
  onPreview,
}: {
  readonly edition: PipelineResumeEditionAvailable;
  readonly currentRequisitionId: string;
  readonly isSelected: boolean;
  readonly canSetSelection: boolean;
  readonly canPreview: boolean;
  readonly busy: boolean;
  readonly onUse: () => void;
  readonly onPreview: () => void;
}): JSX.Element {
  // §3/§10 — a revision tailored for THIS requisition is distinguished from a
  // general one; the revision ordinal gives the recruiter a stable identity beyond
  // the (often identical) filename.
  const tailoredForThis =
    edition.requisition_id !== null && edition.requisition_id === currentRequisitionId;
  const context = tailoredForThis ? 'Tailored for this requisition' : 'General resume';
  return (
    <li className="rc-cdp__resume" data-testid={`resume-row-${edition.edition_id}`}>
      <span className="rc-cdp__resumemain">
        <span className="rc-cdp__resumename">{edition.filename}</span>
        <span className="rc-cdp__resumectx" data-testid={`resume-context-${edition.edition_id}`}>
          {edition.revision_number !== null ? `Revision ${edition.revision_number} · ` : ''}
          {context}
        </span>
      </span>
      <span className="rc-cdp__resumetags">
        {tailoredForThis ? <StatusPill tone="info">Tailored</StatusPill> : null}
        {edition.is_default ? <StatusPill tone="neutral">Default</StatusPill> : null}
        {isSelected ? (
          <StatusPill tone="ok" dot>
            Selected
          </StatusPill>
        ) : null}
      </span>
      <span className="rc-cdp__resumeactions">
        {canPreview ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            data-testid={`resume-preview-${edition.edition_id}`}
            onClick={onPreview}
          >
            Preview
          </Button>
        ) : null}
        {canSetSelection && !isSelected ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            data-testid={`resume-use-${edition.edition_id}`}
            disabled={busy}
            onClick={onUse}
          >
            {busy ? 'Setting…' : 'Use this resume'}
          </Button>
        ) : null}
      </span>
    </li>
  );
}
