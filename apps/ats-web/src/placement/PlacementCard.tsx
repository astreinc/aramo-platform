import { allowedActions } from './board-derivation';
import { PLACEMENT_STATE_LABELS, type PlacementView } from './types';

// E1-d — a placement board card. Renders the AUTHORITATIVE placement lifecycle
// state and offers ONLY the transition actions the actor's scopes permit
// (allowedActions) — a recruiter is never shown activate/terminate (Proof 8). It
// renders NO reason evidence: reason code/label/detail live only on the event
// timeline (D-1/D-2). Placement is owned by the placement lifecycle; there is no
// Pipeline representation to reconcile against (Pipeline owns recruiting progress
// only — Legacy-Pipeline-Canonicalization).
//
// Transition affordances render ONLY when the composition supplies an `onAction`
// handler — i.e. iff there is a real authorized action capability behind them.
// A surface that does not (yet) wire the placement transition-write seam mounts
// this card WITHOUT `onAction`, and no dead/inert transition button is shown;
// the placement information stays fully visible. When `onAction` IS supplied the
// affordance behaviour is unchanged (scope-filtered, per-target).
export interface PlacementCardProps {
  readonly placement: PlacementView;
  readonly scopes: readonly string[];
  readonly onAction?: (to: string) => void;
}

export function PlacementCard({ placement, scopes, onAction }: PlacementCardProps) {
  const actions = allowedActions(placement.state, scopes);
  return (
    <div className="placement-card" data-testid="placement-card" data-placement-id={placement.id}>
      <span className="placement-card__state" data-testid="placement-state">
        {PLACEMENT_STATE_LABELS[placement.state]}
      </span>
      {onAction !== undefined && actions.length > 0 ? (
        <div className="placement-card__actions">
          {actions.map((a) => (
            <button
              key={a.to}
              type="button"
              className="placement-card__action"
              data-authority-class={a.authorityClass}
              onClick={() => onAction(a.to)}
            >
              {PLACEMENT_STATE_LABELS[a.to]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
