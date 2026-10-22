import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, RadioGroup, fetchSession, hasScope } from '@aramo/fe-foundation';

import { setPipelineResumeEdition } from '../pipeline/pipeline-api';
import { talentRequisition360Path } from '../requisitions/talent-requisition-360/route';
import { StatusPill } from '../ui';

import { listTalentResumeEditions } from './talent-api';
import type { TalentResumeEditionView } from './types';

// ATS-QA-1 I-5 (amendment A4) — the résumé choice shown while adding ONE Talent to a
// requisition (Talent side: AddToRequisitionDialog; requisition side: AddTalentDialog).
//
// - Shown only to callers holding pipeline:resume:set, and only when the Talent has
//   MORE THAN ONE active edition. One edition (or none) → no prompt, the add behaves
//   exactly as before (the Talent default stays a suggestion; nothing is bound).
// - The Talent's suggested default is preselected and marked; the recruiter's choice
//   is explicit (they confirm the add with it showing).
// - After the pipeline add succeeds, the choice is written through the existing
//   governed PUT /v1/pipelines/:id/resume-edition (server checks: edition belongs to
//   this Talent + tenant, is active, caller holds the scope, requisition visible).
//   A refused selection never undoes the add: the reason is shown with a link to the
//   Talent × Requisition page where the resume can be chosen.
// - Consent, RTR and pipeline eligibility are untouched — this only adds a selection
//   row for the new episode's (talent, requisition).

export const RESUME_SET_SCOPE = 'pipeline:resume:set';

/** pipeline:resume:set — from the host's prop when given, else resolved from the
 *  session the first time the dialog opens (one read per dialog). null while that
 *  read is in flight (the add waits for it rather than guessing). */
export function useCanSetResume(open: boolean, override: boolean | undefined): boolean | null {
  const [fromSession, setFromSession] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || override !== undefined || fromSession !== null) return;
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (!cancelled)
          setFromSession(s !== null && Array.isArray(s.scopes) && hasScope(s, RESUME_SET_SCOPE));
      })
      .catch(() => {
        if (!cancelled) setFromSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, override, fromSession]);
  return override ?? fromSession;
}

/** Active editions in picker order: tailored for this requisition, then the default,
 *  then the rest newest first. */
export function orderResumeChoices(
  editions: readonly TalentResumeEditionView[],
  requisitionId: string | null,
): TalentResumeEditionView[] {
  const order = (e: TalentResumeEditionView): number =>
    requisitionId !== null && e.requisition_id === requisitionId ? 0 : e.is_default ? 1 : 2;
  return editions
    .filter((e) => e.lifecycle_status === 'active')
    .sort((a, b) => order(a) - order(b) || b.created_at.localeCompare(a.created_at));
}

/** The preselected edition: the Talent's suggested default, else the first offered. */
export function suggestedResumeId(choices: readonly TalentResumeEditionView[]): string | null {
  return (choices.find((e) => e.is_default) ?? choices[0])?.edition_id ?? null;
}

export type ResumeChoiceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  // No prompt: one or no active edition, the caller lacks the scope, or the list
  // could not be read (the add then proceeds exactly as before).
  | { readonly kind: 'none'; readonly talentId: string }
  | {
      readonly kind: 'choose';
      readonly talentId: string;
      readonly choices: readonly TalentResumeEditionView[];
    };

/** Loads the Talent's editions when a Talent is targeted and the caller may choose. */
export function useResumeChoices(
  talentId: string | null,
  requisitionId: string | null,
  canSetResume: boolean | null,
): ResumeChoiceState {
  const [state, setState] = useState<ResumeChoiceState>({ kind: 'idle' });
  useEffect(() => {
    if (talentId === null) {
      setState({ kind: 'idle' });
      return;
    }
    if (canSetResume !== true) {
      setState(canSetResume === null ? { kind: 'loading' } : { kind: 'none', talentId });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    listTalentResumeEditions(talentId)
      .then((r) => {
        if (cancelled) return;
        const choices = orderResumeChoices(
          Array.isArray(r.editions) ? r.editions : [],
          requisitionId,
        );
        setState(
          choices.length > 1 ? { kind: 'choose', talentId, choices } : { kind: 'none', talentId },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'none', talentId });
      });
    return () => {
      cancelled = true;
    };
  }, [talentId, requisitionId, canSetResume]);
  return state;
}

export function ResumeChoiceField({
  choices,
  value,
  onChange,
  requisitionId,
  disabled = false,
}: {
  readonly choices: readonly TalentResumeEditionView[];
  readonly value: string | null;
  readonly onChange: (editionId: string) => void;
  readonly requisitionId: string | null;
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <fieldset className="rc-field" data-testid="add-resume-choice">
      <legend className="rc-field__label">Resume for this requisition</legend>
      <p className="rc-muted">
        This talent has {choices.length} resumes. The default is preselected — choose the one to use
        for this requisition.
      </p>
      <RadioGroup
        name="add-resume-choice"
        value={value ?? ''}
        onValueChange={onChange}
        disabled={disabled}
        options={choices.map((e) => ({
          value: e.edition_id,
          label: (
            <span data-testid={`add-resume-option-${e.edition_id}`}>
              {e.label !== null && e.label.trim() !== '' ? `${e.label} · ` : ''}
              {e.filename}
              {e.revision_number !== null ? ` · Revision ${e.revision_number}` : ''}
              {requisitionId !== null && e.requisition_id === requisitionId ? (
                <>
                  {' '}
                  <StatusPill tone="info">Tailored for this requisition</StatusPill>
                </>
              ) : null}
              {e.is_default ? (
                <>
                  {' '}
                  <StatusPill tone="neutral">Current default</StatusPill>
                </>
              ) : null}
            </span>
          ),
        }))}
      />
    </fieldset>
  );
}

/** Plain reason for a refused selection write (the add itself has already succeeded). */
export function resumeSelectionErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403)
      return 'You don’t have permission to choose the resume for a requisition.';
    if (err.status === 404) return 'That resume is no longer available for this talent.';
    if (err.status === 422) return 'That resume has been archived or withdrawn.';
  }
  return 'The resume choice couldn’t be saved.';
}

/** Writes the chosen edition for the newly added episode. Returns null on success, or
 *  the plain reason it was refused. */
export async function saveResumeChoice(
  pipelineId: string,
  editionId: string,
): Promise<string | null> {
  try {
    await setPipelineResumeEdition(pipelineId, { resume_edition_id: editionId });
    return null;
  } catch (err) {
    return resumeSelectionErrorMessage(err);
  }
}

/** The outcome line when the add succeeded but the résumé choice was refused. */
export function ResumeChoiceRefused({
  reason,
  requisitionId,
  talentId,
}: {
  readonly reason: string;
  readonly requisitionId: string;
  readonly talentId: string;
}): JSX.Element {
  return (
    <p className="rc-muted" role="status" data-testid="add-resume-refused">
      The talent was added, but the resume choice wasn’t saved: {reason}{' '}
      <Link to={talentRequisition360Path(requisitionId, talentId)}>
        Choose the resume for this requisition
      </Link>
    </p>
  );
}
