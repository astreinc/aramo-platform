import { Link } from 'react-router-dom';

import type {
  JourneyOwner,
  TalentRequisitionJourney,
} from '../pipeline/talent-journey-api';

// S3 — the drawer's Talent Journey, rendered from the BACKEND-OWNED Unified
// Talent Journey (GET /v1/pipelines/:id/journey). It is a GOVERNED next-action
// cockpit, NOT a feature menu: milestone progress and the primary action are
// derived from REAL owner-backed contributions + the current lane's legal action,
// never from the mere existence of the Talent row or a loose reading of actions[].
//
// Hard rules (workflow-sequencing correctness):
//   • A milestone is DONE only when a real LATER owner contribution proves the
//     journey passed it (never by ordinal against a defaulted future stage).
//   • CURRENT is the furthest REAL owner contribution. The ONLY promotion past a
//     real contribution is ClientSelection === SELECTED (client complete) → Offer
//     becomes the next actionable milestone — and only from that real precondition.
//   • A future owner with NO row is PENDING, and its actions are never shown.
//   • Offer/Create-offer NEVER appears from "a Talent was added" / "a pipeline
//     exists" / an offer action in actions[]; it requires SELECTED.

const MILESTONES = [
  { key: 'recruiting', label: 'Recruiting' },
  { key: 'client', label: 'Client' },
  { key: 'offer', label: 'Offer' },
  { key: 'pre-start', label: 'Pre-Start' },
  { key: 'employment', label: 'Employment' },
] as const;
type MilestoneKey = (typeof MILESTONES)[number]['key'];

// Backend journey owner → presentation milestone (the three client-side owners
// all roll up to the single "Client" milestone).
const OWNER_MILESTONE: Record<JourneyOwner, MilestoneKey> = {
  pipeline: 'recruiting',
  submittal: 'client',
  'client-selection': 'client',
  interview: 'client',
  offer: 'offer',
  'pre-start': 'pre-start',
  placement: 'employment',
  assignment: 'employment',
};

function milestoneIndex(key: MilestoneKey): number {
  return MILESTONES.findIndex((m) => m.key === key);
}

// A contribution's milestone is derived from its FUNNEL STAGE, not merely its
// owner — the placement owner spans two milestones: PRE_START/READY (+ the
// accepted/placed establishment point) belong to Pre-Start; only STARTED (and
// beyond) is Employment. Mapping by owner alone would wrongly show Employment
// for a placement still in Pre-Start. Owner is the fallback for any unmapped stage.
const STAGE_MILESTONE: Record<string, MilestoneKey> = {
  SOURCED: 'recruiting',
  CONTACTED: 'recruiting',
  ENGAGED: 'recruiting',
  QUALIFYING: 'recruiting',
  QUALIFIED: 'recruiting',
  NOT_IN_CONSIDERATION: 'recruiting',
  SUBMITTED: 'client',
  CLIENT_REVIEW: 'client',
  INTERVIEW: 'client',
  CLIENT_DECLINED: 'client',
  OFFER: 'offer',
  ACCEPTED_PLACED: 'pre-start',
  PRE_START: 'pre-start',
  READY: 'pre-start',
  STARTED: 'employment',
  COMPLETED: 'employment',
};
function stageMilestone(stage: string, owner: JourneyOwner): MilestoneKey {
  return STAGE_MILESTONE[stage] ?? OWNER_MILESTONE[owner];
}

// The canonical Pipeline (Recruiting) ontology as a CLOSED enum→copy map — display
// only. Legality stays backend-owned (the transition POST enforces it). `qualified`
// has NO forward Pipeline action: its next step is the client-submittal handoff.
const RECRUITING_STEPS = [
  { status: 'no_contact', label: 'No contact' },
  { status: 'contacted', label: 'Contacted' },
  { status: 'talent_responded', label: 'Talent responded' },
  { status: 'qualifying', label: 'Qualifying' },
  { status: 'qualified', label: 'Qualified' },
] as const;
const RECRUITING_STEP_INDEX: Record<string, number> = Object.fromEntries(
  RECRUITING_STEPS.map((s, i) => [s.status, i]),
);
// The next legal recruiting advance for each pipeline status (target status for the
// CAS transition). Mirrors RECRUITER_ACTION_TO_STATUS (pipeline-state.ts).
const RECRUITING_NEXT: Record<string, { label: string; to: string }> = {
  no_contact: { label: 'Contact Talent', to: 'contacted' },
  contacted: { label: 'Mark responded', to: 'talent_responded' },
  talent_responded: { label: 'Start qualification', to: 'qualifying' },
  qualifying: { label: 'Qualify Talent', to: 'qualified' },
};

export interface TalentJourneySectionProps {
  readonly journey: TalentRequisitionJourney;
  readonly talentRecordId: string;
  readonly requisitionId: string;
  /** pipeline:change-status — gates the recruiting advance CTA. */
  readonly canAdvancePipeline: boolean;
  /** Governed recruiting advance (CAS transition + journey refetch), owned by the drawer. */
  readonly onRecruitingAdvance: (toStatus: string) => void;
  readonly pipelineBusy: boolean;
  readonly error: string | null;
}

export function TalentJourneySection({
  journey,
  talentRecordId,
  requisitionId,
  canAdvancePipeline,
  onRecruitingAdvance,
  pipelineBusy,
  error,
}: TalentJourneySectionProps): JSX.Element {
  const sub = journey.sub_states;
  const pipelineStage = (sub['pipeline_stage'] as string | null) ?? 'no_contact';
  const submittalState = sub['submittal_state'] as string | null;
  const selectionState = sub['selection_state'] as string | null;
  const interviewState = sub['interview_state'] as string | null;
  const hasOffer = journey.stages.some((s) => s.owner === 'offer');

  // CURRENT milestone from REAL owner contributions only.
  const contribIdxs = journey.stages.map((s) => milestoneIndex(stageMilestone(s.stage, s.owner)));
  let currentIdx = contribIdxs.length > 0 ? Math.max(...contribIdxs) : 0;
  // The ONLY allowed promotion past a real contribution: ClientSelection SELECTED
  // (client phase complete) with no offer yet → Offer is next-actionable. Never
  // from an actions[] entry — strictly from the real SELECTED precondition.
  if (selectionState === 'SELECTED' && !hasOffer) {
    currentIdx = Math.max(currentIdx, milestoneIndex('offer'));
  }
  const currentMilestone = MILESTONES[currentIdx]!.key;

  // Ids for routing to owner surfaces.
  const submittalId =
    journey.stages.find((s) => s.owner === 'submittal')?.source_object_id ?? null;
  const selectionId =
    journey.stages.find(
      (s) => s.owner === 'client-selection' || s.owner === 'interview',
    )?.source_object_id ?? null;

  const nextRecruiting = RECRUITING_NEXT[pipelineStage];
  const currentStepIdx = RECRUITING_STEP_INDEX[pipelineStage] ?? 0;

  return (
    <section className="rc-cdp__sec">
      <div className="rc-cdp__seclabel">Talent journey</div>

      {/* Milestone rail */}
      <ol className="rc-cjr" aria-label="Talent journey">
        {MILESTONES.map((m, i) => {
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'pending';
          return (
            <li key={m.key} className={`rc-cjr__m rc-cjr__m--${state}`}>
              <span className="rc-cjr__dot" aria-hidden="true">
                {state === 'done' ? '✓' : ''}
              </span>
              <span className="rc-cjr__label">{m.label}</span>
              {i < MILESTONES.length - 1 ? (
                <span
                  className={`rc-cjr__line${i < currentIdx ? ' rc-cjr__line--done' : ''}`}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* ── Current lane — exactly one authoritative lane drives the workspace ── */}
      {currentMilestone === 'recruiting' ? (
        <div className="rc-cjr__lane">
          <div className="rc-cjr__laneh">
            <span className="rc-cjr__lanet">Recruiting</span>
            <span className="rc-cjr__owned">owned by Pipeline</span>
          </div>
          <ol className="rc-cjr__checklist">
            {RECRUITING_STEPS.map((step, i) => {
              const st = i < currentStepIdx ? 'done' : i === currentStepIdx ? 'current' : 'pending';
              return (
                <li key={step.status} className={`rc-cjr__ci rc-cjr__ci--${st}`}>
                  <span className="rc-cjr__idot" aria-hidden="true">
                    {st === 'done' ? '✓' : ''}
                  </span>
                  <span className="rc-cjr__ilabel">{step.label}</span>
                  {st === 'current' ? <span className="rc-cjr__chip">CURRENT</span> : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : currentMilestone === 'client' ? (
        <div className="rc-cjr__lane">
          <div className="rc-cjr__laneh">
            <span className="rc-cjr__lanet">Client consideration</span>
            <span className="rc-cjr__owned">
              owned by {interviewState != null ? 'Interview' : 'Client Selection'}
            </span>
          </div>
          <div className="rc-cjr__item rc-cjr__item--current">
            <span className="rc-cjr__idot" aria-hidden="true" />
            <span className="rc-cjr__ilabel">
              {interviewState != null
                ? 'Interview'
                : selectionState != null
                  ? 'Client review'
                  : submittalState === 'submitted_to_ats'
                    ? 'Submitted'
                    : 'Preparing submittal'}
            </span>
            <span className="rc-cjr__chip">CURRENT</span>
          </div>
        </div>
      ) : currentMilestone === 'offer' ? (
        <div className="rc-cjr__lane">
          <div className="rc-cjr__laneh">
            <span className="rc-cjr__lanet">Client decision</span>
            <span className="rc-cjr__owned">owned by Client Selection</span>
          </div>
          <div className="rc-cjr__item rc-cjr__item--current">
            <span className="rc-cjr__idot" aria-hidden="true" />
            <span className="rc-cjr__ilabel">Selected</span>
            <span className="rc-cjr__chip">CURRENT</span>
          </div>
        </div>
      ) : (
        <div className="rc-cjr__lane">
          <div className="rc-cjr__laneh">
            <span className="rc-cjr__lanet">
              {currentMilestone === 'pre-start' ? 'Pre-Start' : 'Employment'}
            </span>
            <span className="rc-cjr__owned">
              owned by {currentMilestone === 'pre-start' ? 'Pre-Start' : 'Placement'}
            </span>
          </div>
        </div>
      )}

      {/* ── Next step — the current lane's single legal action ── */}
      <div className="rc-cjr__next">
        <span className="rc-cjr__nextl">Next step</span>
        {currentMilestone === 'recruiting' ? (
          nextRecruiting != null ? (
            <div className="rc-cjr__nextbody">
              <p className="rc-cjr__nexttxt">{nextRecruiting.label}</p>
              {canAdvancePipeline ? (
                <button
                  type="button"
                  className="rc-cjr__cta"
                  disabled={pipelineBusy}
                  onClick={() => onRecruitingAdvance(nextRecruiting.to)}
                >
                  {nextRecruiting.label}
                </button>
              ) : (
                <p className="rc-cjr__why">You do not have permission for this action.</p>
              )}
            </div>
          ) : (
            // pipelineStage === 'qualified' → the client-submittal handoff.
            <div className="rc-cjr__nextbody">
              <p className="rc-cjr__nexttxt">Prepare Talent for the client submittal</p>
              <Link
                to={`/talent/${talentRecordId}/submittal/${requisitionId}`}
                className="rc-cjr__cta"
              >
                Prepare submittal
              </Link>
              <p className="rc-cjr__why">
                Make offer is not available yet — offers unlock after client selection.
              </p>
            </div>
          )
        ) : currentMilestone === 'client' ? (
          <div className="rc-cjr__nextbody">
            <p className="rc-cjr__nexttxt">
              {interviewState != null
                ? 'Record the interview outcome'
                : selectionState != null
                  ? 'Await client decision'
                  : 'Submit this Talent to the client'}
            </p>
            {selectionId != null ? (
              <Link to={`/selections/${selectionId}`} className="rc-cjr__cta">
                {interviewState != null ? 'View interview' : 'View submittal'}
              </Link>
            ) : submittalId != null ? (
              <Link
                to={`/talent/${talentRecordId}/submittal/${requisitionId}`}
                className="rc-cjr__cta"
              >
                View submittal
              </Link>
            ) : null}
          </div>
        ) : currentMilestone === 'offer' ? (
          <div className="rc-cjr__nextbody">
            <p className="rc-cjr__nexttxt">Create offer for this Talent</p>
            <p className="rc-cjr__why">
              Client selection is recorded — offer creation is available below.
            </p>
          </div>
        ) : (
          <p className="rc-cjr__nexttxt rc-cjr__nexttxt--muted">
            This stage is owned by its aggregate — no drawer action here yet.
          </p>
        )}
      </div>

      {error != null ? <p className="rc-cdp__err">{error}</p> : null}

      <p className="rc-cdp__note">
        Each stage is a summary of its owning workflow — actions appear only when
        that workflow and your permissions allow them.
      </p>
    </section>
  );
}
