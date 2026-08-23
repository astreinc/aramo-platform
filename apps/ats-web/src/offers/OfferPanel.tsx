import { offerActionsFor, type OfferAffordance } from './offer-affordance';
import { RECRUITING_OFFER_STATE_LABELS } from './labels';
import type { OfferState } from './types';

// Offer Lifecycle (D7) — the Offer panel. Renders the current offer state + the
// named governed affordances (Send / Negotiate / Accept / Decline / Expire /
// Rescind / Revise) gated by (state × offer:* scope). The affordance is COSMETIC:
// each fires onAction(toState) which the container PATCHes to /v1/offers/:id; the
// BE fail-closed policy + DB trigger are the real authority. No portal, no
// capacity, no Pipeline-`offered` coupling (scope fence).
export interface OfferPanelProps {
  readonly state: OfferState;
  readonly scopes: readonly string[];
  readonly onAction: (a: OfferAffordance) => void;
}

export function OfferPanel({ state, scopes, onAction }: OfferPanelProps): JSX.Element {
  const actions = offerActionsFor(state, scopes);
  return (
    <section className="rc-offer" aria-label="Offer">
      <header className="rc-offer__head">
        <span className="rc-offer__label">Offer</span>
        <span className="rc-offer__state">{RECRUITING_OFFER_STATE_LABELS[state]}</span>
      </header>
      {actions.length > 0 ? (
        <div className="rc-offer__actions">
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              className={`rc-hbtn${a.action === 'ACCEPT' ? ' rc-hbtn--primary' : ''}`}
              onClick={() => onAction(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
