import { Icons } from '../ui';

import {
  CONSENT_CAPTURED_METHOD,
  CONSENT_EXPIRY_LABEL,
  CONSENT_SCOPE_DEFS,
  type ConsentScope,
  type ConsentState,
} from './consent';

interface ConsentCaptureProps {
  readonly value: ConsentState;
  readonly onToggle: (scope: ConsentScope) => void;
  readonly disabled?: boolean;
}

// The 5-scope consent-capture rail card (mockup parity). Each scope is a
// real CONSENT_SCOPES value (libs/consent). The recruiter toggles the
// non-required scopes; the two required scopes gate the save.
//
// NOTE: capturing here records the recruiter's intent in form state. The
// grant is NOT fired this PR (keying carry — see ./consent.ts and
// doc/go-live-known-limitations.md). The deferred-grant note states this
// honestly rather than implying consent is already persisted.
export function ConsentCapture({
  value,
  onToggle,
  disabled = false,
}: ConsentCaptureProps) {
  const contactingOn = value.contacting;
  return (
    <section className="rc-sidecard rc-consent" aria-label="Consent capture">
      <h3 className="rc-sidecard__h">
        <Icons.IconShield />
        Consent capture
      </h3>
      <ul className="rc-consent__list">
        {CONSENT_SCOPE_DEFS.map((def) => {
          const on = value[def.key];
          return (
            <li
              key={def.key}
              className={`rc-consent__item${on ? ' rc-consent__item--on' : ''}`}
            >
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={def.label}
                className="rc-consent__ck"
                disabled={disabled || def.required}
                onClick={() => onToggle(def.key)}
              >
                <span className="rc-consent__box" aria-hidden="true">
                  {on ? <Icons.IconCheck /> : null}
                </span>
              </button>
              <div className="rc-consent__body">
                <div className="rc-consent__lb">{def.label}</div>
                <div className="rc-consent__s">{def.summary}</div>
              </div>
              {def.required ? (
                <span className="rc-consent__req">required</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <dl className="rc-consent__meta">
        <dt>Method</dt>
        <dd className="mono">{CONSENT_CAPTURED_METHOD}</dd>
        <dt>Expires</dt>
        <dd>{CONSENT_EXPIRY_LABEL}</dd>
      </dl>
      {!contactingOn ? (
        <p className="rc-consent__note">
          <Icons.IconInfo />
          <span>
            Without <b>Contacting</b> consent, the talent is created but not
            contactable until consent is captured.
          </span>
        </p>
      ) : null}
      <p className="rc-consent__note rc-consent__note--defer">
        <Icons.IconInfo />
        <span>
          Consent is recorded against the talent’s Aramo Core identity, which
          is provisioned after go-live. Until then these choices are captured
          with the record and applied when the identity is linked.
        </span>
      </p>
    </section>
  );
}
