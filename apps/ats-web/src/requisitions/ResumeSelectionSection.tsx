import { useEffect, useState } from 'react';

import {
  getPipelineResumeEdition,
  setPipelineResumeEdition,
} from '../pipeline/pipeline-api';
import type {
  PipelineResumeEditionAvailable,
  PipelineResumeEditionView,
} from '../pipeline/types';

// TI-1D-D — the Requisition-context résumé selection surface, inside the
// requisition's Talent detail drawer. It distinguishes THREE things the recruiter
// must never conflate:
//   1. the EXPLICIT working selection for THIS requisition (Layer A truth);
//   2. the Talent-global default — a SUGGESTION only, shown when nothing is
//      selected yet, and NEVER auto-bound;
//   3. the editions available to newly select.
// PREVIEW never binds: opening a résumé to read it is inert — only the explicit
// "Use this résumé" button issues the governed PUT (pipeline:resume:set). The
// send-time freeze is a separate step owned by the submittal surface.
export interface ResumeSelectionSectionProps {
  readonly pipelineId: string;
  // scopes.includes('pipeline:resume:set') — gates the mutating affordance only.
  readonly canSetSelection: boolean;
}

export function ResumeSelectionSection({
  pipelineId,
  canSetSelection,
}: ResumeSelectionSectionProps): JSX.Element {
  const [view, setView] = useState<PipelineResumeEditionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPipelineResumeEdition(pipelineId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setErr('Résumé selection is unavailable for this talent.');
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
      .catch(() => setErr('Could not set the résumé — the backend rejected this.'))
      .finally(() => setBusyId(null));
  };

  if (view === null) {
    return (
      <section className="rc-cdp__sec" data-testid="resume-selection">
        <div className="rc-cdp__seclabel">Résumé — this position</div>
        <p className="rc-cdp__note">{err ?? 'Loading résumé selection…'}</p>
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

  return (
    <section className="rc-cdp__sec" data-testid="resume-selection">
      <div className="rc-cdp__seclabel">Résumé — this position</div>

      {selected !== null ? (
        <p className="rc-cdp__note" data-testid="resume-current-selection">
          Selected for this requisition: <strong>{selected.filename}</strong>
        </p>
      ) : defaultEdition !== null ? (
        // The default is a SUGGESTION only — explicitly labelled, never bound.
        <p className="rc-cdp__note" data-testid="resume-default-suggestion">
          No résumé selected yet. Suggested default:{' '}
          <strong>{defaultEdition.filename}</strong> — select one below to use it for
          this requisition.
        </p>
      ) : (
        <p className="rc-cdp__note">No résumé selected yet.</p>
      )}

      {err !== null ? <p className="rc-cdp__err">{err}</p> : null}

      <ul className="rc-cdp__resumes">
        {editions.map((e) => (
          <ResumeRow
            key={e.edition_id}
            edition={e}
            isSelected={e.edition_id === selectedId}
            canSetSelection={canSetSelection}
            busy={busyId === e.edition_id}
            onUse={() => handleUse(e.edition_id)}
          />
        ))}
      </ul>
    </section>
  );
}

function ResumeRow({
  edition,
  isSelected,
  canSetSelection,
  busy,
  onUse,
}: {
  readonly edition: PipelineResumeEditionAvailable;
  readonly isSelected: boolean;
  readonly canSetSelection: boolean;
  readonly busy: boolean;
  readonly onUse: () => void;
}): JSX.Element {
  return (
    <li className="rc-cdp__resume" data-testid={`resume-row-${edition.edition_id}`}>
      <span className="rc-cdp__resumename">{edition.filename}</span>
      {edition.is_default ? <span className="rc-cdp__resumetag">Default</span> : null}
      {isSelected ? <span className="rc-cdp__resumetag">Selected</span> : null}
      {/* PREVIEW — DISABLED (TI-1E-B1). The prior href pointed at
          /talent/:id/resume-editions/:editionId, which has no route (dead link);
          the pipeline edition payload also lacks the attachment identity the
          attachment download API needs. Edition-aware viewing is TI-1H, so the
          action is inert here (never binds, issues no PUT). */}
      <button
        type="button"
        className="rc-cdp__resumeprev"
        data-testid={`resume-preview-${edition.edition_id}`}
        disabled
        title="Résumé preview is coming soon"
      >
        Preview
      </button>
      {canSetSelection && !isSelected ? (
        <button
          type="button"
          className="rc-cdp__resumeuse"
          data-testid={`resume-use-${edition.edition_id}`}
          disabled={busy}
          onClick={onUse}
        >
          {busy ? 'Setting…' : 'Use this résumé'}
        </button>
      ) : null}
    </li>
  );
}
