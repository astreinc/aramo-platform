import { useEffect, useState } from 'react';

import { getEngagementReadiness, type EngagementReadiness } from './engagement-api';
import { EngagementOverridePrompt } from './EngagementOverridePrompt';

// COMM-C3 — the recruiter Submittal-readiness summary (R19). Provider-neutral,
// truthful per-requirement status; loaded when the drawer opens (no first-paint
// list fan-out, R18). It MUST NOT claim a Talent is Qualified because the gate
// passes — it states only whether the engagement requirements are met.

// ATS-QA-1 I-1 UX — plain recruiter copy. An unknown status/channel from the server shows a
// neutral label, never the raw enum value.
const STATUS_LABEL: Record<string, string> = {
  satisfied: 'done',
  not_required: 'not needed',
  missing: 'not recorded yet',
  insufficient_strength: 'recorded, but a stronger record is needed',
  unavailable: 'couldn’t be checked right now',
  no_producer: 'not available in Aramo yet',
};
const UNKNOWN_STATUS = 'status unknown';

const CHANNEL_LABEL: Record<string, string> = { voice: 'Voice conversation', email: 'Email exchange' };
const UNKNOWN_CHANNEL = 'Engagement requirement';

// The next step for each unmet requirement, by channel.
const NEXT_STEP: Record<string, string> = {
  voice: 'log a voice conversation with the Talent',
  email: 'log an email exchange with the Talent',
};

function nextStepCopy(r: EngagementReadiness): string {
  if (r.unavailable) {
    return 'Next step: some records couldn’t be checked right now. Reload in a moment to check again.';
  }
  const steps = r.results
    .filter((res) => res.required && res.status !== 'satisfied' && res.status !== 'not_required')
    .map((res) => NEXT_STEP[res.channel])
    .filter((x): x is string => x !== undefined);
  const unique = [...new Set(steps)];
  if (unique.length === 0) return 'Next step: reload to check again, or ask your Aramo admin which requirement is open.';
  return `Next step: ${unique.join(', then ')}.`;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; readiness: EngagementReadiness }
  | { kind: 'error' };

export function EngagementReadinessSummary({
  talentId,
  requisitionId,
  loadFn = getEngagementReadiness,
  canOverride = false,
  onOverride,
}: {
  readonly talentId: string;
  readonly requisitionId: string;
  readonly loadFn?: typeof getEngagementReadiness;
  /** PART A — the actor holds engagement:policy:override (from session scopes). */
  readonly canOverride?: boolean;
  /** PART A — submit with an override reason (wires to submitToClient). */
  readonly onOverride?: (reason: string) => void | Promise<void>;
}): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    loadFn(talentId, requisitionId)
      .then((r) => {
        if (!cancelled) setState({ kind: 'ready', readiness: r });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [talentId, requisitionId, loadFn]);

  if (state.kind === 'loading') {
    return <p className="rc-cdp__note" data-testid="engagement-readiness-loading">Loading submittal readiness…</p>;
  }
  if (state.kind === 'error') {
    return (
      <p className="rc-cdp__note" data-testid="engagement-readiness-error">
        Submittal readiness couldn’t be loaded. Reload to try again.
      </p>
    );
  }

  const r = state.readiness;
  if (!r.policy_present) {
    // Amendment three-state: never-governed tenant is DORMANT (no engagement
    // requirements); a governed tenant with no effective policy is fail-closed.
    if (!r.governed) {
      return (
        <p className="rc-cdp__note" data-testid="engagement-readiness-dormant">
          No engagement requirements apply to your organization. Client submittal follows the usual checks.
        </p>
      );
    }
    return (
      <p className="rc-cdp__note" data-testid="engagement-readiness-nopolicy">
        Client submittal is blocked: your organization requires engagement checks, but no engagement policy is in
        effect yet. Next step: ask your Aramo admin to publish one.
      </p>
    );
  }

  return (
    <div data-testid="engagement-readiness">
      <ul className="rc-cjr__checklist" style={{ margin: 0 }}>
        {r.results
          .filter((res) => res.required)
          .map((res) => {
            const done = res.status === 'satisfied';
            return (
              <li key={res.channel} className={`rc-cjr__ci rc-cjr__ci--${done ? 'done' : 'pending'}`}>
                <span className="rc-cjr__idot" aria-hidden="true">{done ? '✓' : ''}</span>
                <span className="rc-cjr__ilabel">
                  {CHANNEL_LABEL[res.channel] ?? UNKNOWN_CHANNEL} — {STATUS_LABEL[res.status] ?? UNKNOWN_STATUS}
                </span>
              </li>
            );
          })}
      </ul>
      <p className="rc-cdp__note" data-testid="engagement-readiness-verdict">
        {r.satisfied
          ? 'Engagement requirements met for client submittal.'
          : 'Client submittal is blocked until the engagement requirements are met.'}
      </p>
      {!r.satisfied ? (
        <p className="rc-cdp__note" data-testid="engagement-readiness-next-step">
          {nextStepCopy(r)}
        </p>
      ) : null}
      {/* PART A (A9) — the override affordance appears only under an
          ENFORCING_WITH_OVERRIDE policy with missing evidence; authority is the
          engagement:policy:override scope. Read-error remains non-overridable. */}
      <EngagementOverridePrompt readiness={r} canOverride={canOverride} onOverride={onOverride ?? (() => undefined)} />
    </div>
  );
}
