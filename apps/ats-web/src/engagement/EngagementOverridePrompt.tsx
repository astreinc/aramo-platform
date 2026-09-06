import { useState } from 'react';

import type { EngagementReadiness } from './engagement-api';

// COMM PART A (A9) — the recruiter/authorized-user override affordance at Submit
// to client. It appears ONLY when the effective policy is ENFORCING_WITH_OVERRIDE
// and required evidence is missing (`override_available`). Whether the actor MAY
// override is a scope check (engagement:policy:override) resolved by the caller and
// passed as `canOverride` — least-visibility: a non-authorized user sees only that
// an authorized user can override, never the reason control. A read-error
// (`unavailable`) is fail-closed and NOT overridable. The reason is mandatory.

export interface EngagementOverridePromptProps {
  readonly readiness: EngagementReadiness;
  /** The actor holds engagement:policy:override (resolved from session scopes). */
  readonly canOverride: boolean;
  /** Submit with the override reason (wires to submitToAts's engagement_override). */
  readonly onOverride: (reason: string) => void | Promise<void>;
  readonly busy?: boolean;
}

export function EngagementOverridePrompt(props: EngagementOverridePromptProps): JSX.Element | null {
  const { readiness, canOverride, onOverride, busy } = props;
  const [reason, setReason] = useState('');

  // Not an override situation → render nothing.
  if (readiness.override_available !== true) return null;

  // Read-error is fail-closed and never overridable, even under an override policy.
  if (readiness.unavailable) {
    return (
      <div data-testid="engagement-override-unavailable">
        Required engagement evidence could not be read. Submit to client is blocked and cannot be overridden until
        the evidence system recovers.
      </div>
    );
  }

  const missing = readiness.missing.join(', ');

  if (!canOverride) {
    return (
      <div data-testid="engagement-override-blocked">
        Submit to client is blocked — missing engagement evidence: {missing}. An authorized user may override with a
        recorded reason.
      </div>
    );
  }

  const reasonValid = reason.trim().length > 0;
  return (
    <div data-testid="engagement-override-prompt">
      <p>
        Submit to client is blocked — missing engagement evidence: <strong>{missing}</strong>. As an authorized user
        you may override. This is versioned and logged.
      </p>
      <label>
        Override reason (required)
        <textarea
          data-testid="engagement-override-reason"
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        type="button"
        data-testid="engagement-override-submit"
        disabled={!reasonValid || busy === true}
        onClick={() => {
          if (reasonValid) void onOverride(reason.trim());
        }}
      >
        Override &amp; Submit to client
      </button>
    </div>
  );
}
