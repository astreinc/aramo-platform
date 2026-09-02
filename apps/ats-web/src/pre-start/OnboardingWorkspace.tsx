import { canMarkReady, requirementActionsFor, type RequirementAffordance } from './pre-start-affordance';
import { REQUIREMENT_STATUS_LABELS, type PreStartPlacementRequirements, type PreStartRequirementView } from './types';

// L5-P7 — the dedicated onboarding workspace (the OWNING pre-start surface). Renders
// overall readiness, each requirement (status · blocking · satisfaction policy · owner ·
// evidence), and the governed affordances (Satisfy / Verify / Fail / Waive / Reopen)
// gated by (status × policy × scope), plus Mark-ready when the BE says ready. Presentational
// (prop-driven): each affordance fires onRequirementAction; the container POSTs to the
// guarded surface and the BE is the authority (mirrors OfferPanel). No @aramo/pre-start
// import (ADR-0029 hand-mirror).
export interface OnboardingWorkspaceProps {
  readonly data: PreStartPlacementRequirements;
  readonly scopes: readonly string[];
  readonly onRequirementAction: (instanceId: string, affordance: RequirementAffordance) => void;
  readonly onMarkReady: () => void;
}

function readinessText(data: PreStartPlacementRequirements): string {
  if (!data.materialized) return 'Preparing onboarding requirements…';
  if (data.ready) return 'Ready to start — all blocking requirements satisfied';
  return `${data.blocking_unresolved_count} blocking requirement(s) outstanding`;
}

export function OnboardingWorkspace({
  data,
  scopes,
  onRequirementAction,
  onMarkReady,
}: OnboardingWorkspaceProps): JSX.Element {
  const showMarkReady = canMarkReady(data, scopes);
  return (
    <section className="rc-onboarding" aria-label="Onboarding readiness">
      <header className="rc-onboarding__head">
        <span className="rc-onboarding__label">Onboarding</span>
        <span
          className={`rc-onboarding__readiness${data.ready ? ' rc-onboarding__readiness--ready' : ''}`}
          data-ready={data.ready}
        >
          {readinessText(data)}
        </span>
        {showMarkReady ? (
          <button type="button" className="rc-hbtn rc-hbtn--primary" onClick={() => onMarkReady()}>
            Mark ready to start
          </button>
        ) : null}
      </header>

      {data.requirements.length > 0 ? (
        <ul className="rc-onboarding__reqs">
          {data.requirements.map((r) => (
            <RequirementRow key={r.id} r={r} scopes={scopes} onAction={onRequirementAction} />
          ))}
        </ul>
      ) : (
        <p className="rc-onboarding__empty">No requirements materialized for this placement.</p>
      )}
    </section>
  );
}

function RequirementRow({
  r,
  scopes,
  onAction,
}: {
  r: PreStartRequirementView;
  scopes: readonly string[];
  onAction: (instanceId: string, affordance: RequirementAffordance) => void;
}): JSX.Element {
  const actions = requirementActionsFor(r, scopes);
  return (
    <li className="rc-onboarding__req" data-status={r.status} data-blocking={r.blocking}>
      <span className="rc-onboarding__req-label">{r.label}</span>
      {r.blocking ? <span className="rc-onboarding__badge rc-onboarding__badge--blocking">Blocking</span> : null}
      {r.satisfaction_policy === 'VERIFICATION_REQUIRED' ? (
        <span className="rc-onboarding__badge rc-onboarding__badge--verify">Verification required</span>
      ) : null}
      <span className="rc-onboarding__req-status">{REQUIREMENT_STATUS_LABELS[r.status]}</span>
      {r.owner_role ? <span className="rc-onboarding__req-owner">Owner: {r.owner_role}</span> : null}
      {actions.length > 0 ? (
        <span className="rc-onboarding__req-actions">
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              className={`rc-hbtn${a.action === 'SATISFY' || a.action === 'VERIFY' ? ' rc-hbtn--primary' : ''}`}
              onClick={() => onAction(r.id, a)}
            >
              {a.label}
            </button>
          ))}
        </span>
      ) : null}
    </li>
  );
}
