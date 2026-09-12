import { useCallback, useEffect, useState } from 'react';

import { Button } from '../ui';
import { StatChip } from '../settings/components';
import {
  getTenantChannelReadiness as defaultLoadReadiness,
  type TenantChannelReadiness,
} from '../communications/tenant-channel-readiness';

import {
  getEngagementCapabilities as defaultLoadCaps,
  getEngagementPolicyState as defaultLoadState,
  publishEngagementPolicy as defaultPublish,
  type EngagementCapability,
  type EngagementEnforcementMode,
  type EngagementEvidenceStrength,
  type EngagementPolicyState,
  type EngagementRequirement,
  type PublishEngagementPolicyInput,
} from './engagement-policy-api';

// PART A — enforcement modes surfaced as radios (map 1:1 to the backend enum).
// "Enforcing with manager override" is the product label; the underlying authority
// is the `engagement:policy:override` scope, never a role name.
const ENFORCEMENT_OPTIONS: ReadonlyArray<{ mode: EngagementEnforcementMode; label: string; desc: string }> = [
  { mode: 'ADVISORY', label: 'Advisory', desc: 'Recruiters see a warning at Submit to client but can proceed. Recommended first step.' },
  { mode: 'ENFORCING', label: 'Enforcing', desc: 'Submit to client is blocked until required evidence exists.' },
  {
    mode: 'ENFORCING_WITH_OVERRIDE',
    label: 'Enforcing with manager override',
    desc: 'Blocked for recruiters; users with override permission may proceed with a recorded reason.',
  },
];

const ICON_MAIL = 'M4 5h16v14H4z M4 7l8 5 8-5';
const ICON_VOICE =
  'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z';
const ICON_SMS = 'M4 4h16v12H8l-4 4z';

function EngIcon({ path }: { readonly path: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

// One evidence row (prototype parity): icon · label/desc · availability chip ·
// require toggle. A channel that isn't available (no configured provider, or SMS
// which is execution-deferred) shows the toggle disabled — it can't be required.
function EvidenceRow(props: {
  readonly icon: string;
  readonly label: string;
  readonly desc: string;
  readonly statusLabel: string;
  readonly statusTone: 'ok' | 'warn' | 'muted';
  readonly on: boolean;
  readonly available: boolean;
  readonly testId: string;
  readonly statusTestId?: string;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <div className="eng-ev">
      <span className="eng-ev__ic"><EngIcon path={props.icon} /></span>
      <span className="eng-ev__main">
        <span className="eng-ev__lb">{props.label}</span>
        <span className="eng-ev__desc">{props.desc}</span>
      </span>
      <span data-testid={props.statusTestId}>
        <StatChip tone={props.statusTone}>{props.statusLabel}</StatChip>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.on}
        aria-label={`Require ${props.label}`}
        data-testid={props.testId}
        className={`eng-tog${props.on ? ' eng-tog--on' : ''}`}
        disabled={!props.available}
        title={props.available ? 'Require this evidence' : props.statusLabel}
        onClick={props.onToggle}
      >
        <span className="eng-tog__knob" />
      </button>
    </div>
  );
}

// COMM-C3 — Tenant Engagement Policy administration (Settings → Recruiting →
// Engagement Policy). The C3 three-state is surfaced honestly:
//   never configured (governed=false) → Not configured / NON-ENFORCING
//   configured but no effective policy → No active policy (fail-closed)
//   effective policy present           → Published / ENFORCING (lists requirements)
// A DRAFT is UI-only editing state — it changes nothing until Publish, which is
// the enforcement boundary. Publishing requires >=1 enabled requirement (an
// empty/all-OFF policy is not published — absence of a policy IS the OFF state).
// Provider-neutral: channels only, never a vendor name/token.

export interface EngagementPolicyPanelProps {
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly loadStateFn?: () => Promise<EngagementPolicyState>;
  readonly loadCapabilitiesFn?: () => Promise<EngagementCapability[]>;
  readonly publishFn?: (input: PublishEngagementPolicyInput) => Promise<void>;
  /**
   * PART C (C6/§10) — Tenant OPERATIONAL readiness per channel (a configured
   * provider exists). Distinct from platform capability; composed on the FE.
   */
  readonly loadReadinessFn?: () => Promise<TenantChannelReadiness>;
  /** Test seam for a deterministic version string (defaults to a timestamp). */
  readonly versionFn?: () => string;
}

type DisplayStatus = 'not_configured' | 'no_active_policy' | 'published';

function statusOf(state: EngagementPolicyState): DisplayStatus {
  if (!state.governed) return 'not_configured';
  if (state.effective !== null && state.effective.requirements.length > 0) return 'published';
  return 'no_active_policy';
}

export function EngagementPolicyPanel(props: EngagementPolicyPanelProps): JSX.Element {
  const loadState = props.loadStateFn ?? defaultLoadState;
  const loadCaps = props.loadCapabilitiesFn ?? defaultLoadCaps;
  const loadReadiness = props.loadReadinessFn ?? defaultLoadReadiness;
  const publish = props.publishFn ?? defaultPublish;
  const version = props.versionFn ?? (() => `v${Date.now()}`);

  const [state, setState] = useState<EngagementPolicyState | null>(null);
  const [caps, setCaps] = useState<readonly EngagementCapability[]>([]);
  const [readiness, setReadiness] = useState<TenantChannelReadiness>({ voice: false, email: false });
  const [error, setError] = useState<string | null>(null);
  const [emailRequired, setEmailRequired] = useState(false);
  const [voiceRequired, setVoiceRequired] = useState(false);
  const [voiceStrength, setVoiceStrength] = useState<EngagementEvidenceStrength>('RECRUITER_ATTESTED');
  const [enforcementMode, setEnforcementMode] = useState<EngagementEnforcementMode>('ADVISORY');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, c, r] = await Promise.all([loadState(), loadCaps(), loadReadiness()]);
      setState(s);
      setCaps(c);
      setReadiness(r);
      setError(null);
    } catch {
      setError('engagement_policy_load_failed');
    }
  }, [loadState, loadCaps, loadReadiness]);

  useEffect(() => {
    if (props.canRead) void refresh();
  }, [props.canRead, refresh]);

  // Seed the editable form from the current effective policy. The panel is
  // ALWAYS-EDITABLE (prototype parity) — no separate Configure/Edit mode — so the
  // controls always reflect the current policy and stay live; nothing changes
  // until Publish (the enforcement boundary). A brand-new tenant defaults to
  // ADVISORY (the recommended, non-blocking first step).
  useEffect(() => {
    const reqs = state?.effective?.requirements ?? [];
    const email = reqs.find((r) => r.channel === 'email');
    const voice = reqs.find((r) => r.channel === 'voice');
    setEmailRequired(email?.required === true);
    setVoiceRequired(voice?.required === true);
    setVoiceStrength(voice?.channel === 'voice' ? voice.minimum_strength : 'RECRUITER_ATTESTED');
    setEnforcementMode(state?.effective?.enforcement_mode ?? 'ADVISORY');
  }, [state]);

  const doPublish = useCallback(async () => {
    const requirements: EngagementRequirement[] = [];
    if (emailRequired) {
      requirements.push({ channel: 'email', required: true, condition: 'recorded_evidence' });
    }
    if (voiceRequired) {
      requirements.push({
        channel: 'voice',
        required: true,
        condition: 'two_way_conversation',
        minimum_strength: voiceStrength,
      });
    }
    if (requirements.length === 0) return; // guarded by the disabled button too
    setBusy(true);
    try {
      await publish({ version: version(), scope: 'TENANT', schema_version: 1, requirements, enforcement_mode: enforcementMode });
      await refresh();
    } catch {
      setError('engagement_policy_publish_failed');
    } finally {
      setBusy(false);
    }
  }, [emailRequired, voiceRequired, voiceStrength, enforcementMode, publish, version, refresh]);

  if (!props.canRead) {
    return <div data-testid="engagement-policy-forbidden">You do not have access to Engagement Policy.</div>;
  }
  if (error !== null) {
    return <div data-testid="engagement-policy-error">{error}</div>;
  }
  if (state === null) {
    return <div data-testid="engagement-policy-loading">Loading Engagement Policy…</div>;
  }

  const status = statusOf(state);
  // Platform capability (the channel has a producer at all) vs Tenant readiness
  // (a configured provider exists for this Tenant). C6/§10: a channel is
  // AVAILABLE to require only when BOTH hold. Platform-capable but no configured
  // provider ⇒ "Supported by platform · provider not configured" (not requirable).
  const platformCapable = (ch: 'email' | 'voice'): boolean =>
    caps.find((c) => c.channel === ch)?.available ?? false;
  const channelAvailable = (ch: 'email' | 'voice'): boolean => platformCapable(ch) && readiness[ch];
  const availabilityLabel = (ch: 'email' | 'voice'): string =>
    channelAvailable(ch)
      ? 'Available'
      : platformCapable(ch)
        ? 'Supported by platform · provider not configured'
        : 'Unavailable';

  const statusChip: { tone: 'ok' | 'warn' | 'muted'; label: string } =
    status === 'published'
      ? { tone: 'ok', label: 'Published' }
      : status === 'no_active_policy'
        ? { tone: 'warn', label: 'No active policy' }
        : { tone: 'warn', label: 'Not configured' };
  const chipTone = (label: string): 'ok' | 'warn' | 'muted' =>
    label === 'Available' ? 'ok' : label === 'Unavailable' ? 'muted' : 'warn';
  const canPublish = props.canWrite && !busy && (emailRequired || voiceRequired);

  return (
    <div data-testid="engagement-policy-panel">
      <div className="eng-head">
        <div className="eng-head__main">
          <h1 className="rc-h1">Engagement policy</h1>
          <p className="rc-sub">
            The engagement evidence recruiters must record before <strong>Submit to client</strong>.
            Non-enforcing until published. Communication providers are configured under Integrations.
          </p>
        </div>
        <span data-testid="engagement-policy-status">
          <StatChip tone={statusChip.tone} dot>
            {statusChip.label}
          </StatChip>
        </span>
      </div>

      {status !== 'published' && (
        <div className="eng-notice" data-testid="engagement-policy-notice">
          No engagement requirements are currently enforced before Submit to client. Recruiters can
          submit Talent without recorded engagement evidence until a policy is published.
        </div>
      )}

      {!props.canWrite && (
        <p className="rc-sub" data-testid="engagement-policy-readonly">
          Read-only — you do not have permission to edit this policy.
        </p>
      )}

      <div className="eng-card">
        <div className="eng-card__t">Evidence requirements</div>
        <div className="eng-card__sub">
          Availability is derived from configured communication providers — evidence types without a
          provider cannot be required.
        </div>

        <EvidenceRow
          icon={ICON_MAIL}
          label="Email evidence"
          desc="A sent email to the Talent, recorded through a configured provider."
          statusLabel={availabilityLabel('email')}
          statusTone={chipTone(availabilityLabel('email'))}
          statusTestId="engagement-cap-email"
          on={emailRequired}
          available={props.canWrite && channelAvailable('email')}
          testId="engagement-policy-email-toggle"
          onToggle={() => setEmailRequired((v) => !v)}
        />

        <EvidenceRow
          icon={ICON_VOICE}
          label="Voice evidence"
          desc="A logged call recorded through a configured voice provider."
          statusLabel={availabilityLabel('voice')}
          statusTone={chipTone(availabilityLabel('voice'))}
          statusTestId="engagement-cap-voice"
          on={voiceRequired}
          available={props.canWrite && channelAvailable('voice')}
          testId="engagement-policy-voice-toggle"
          onToggle={() => setVoiceRequired((v) => !v)}
        />
        {voiceRequired && (
          <label className="eng-strength">
            Minimum voice evidence strength
            <select
              className="rc-select"
              data-testid="engagement-policy-voice-strength"
              value={voiceStrength}
              disabled={!props.canWrite}
              onChange={(e) => setVoiceStrength(e.target.value as EngagementEvidenceStrength)}
            >
              <option value="RECRUITER_ATTESTED">Recruiter attested</option>
              <option value="PROVIDER_VERIFIED">Provider verified</option>
            </select>
          </label>
        )}

        {/* SMS — declared by the provider but execution-deferred; shown for
            completeness, never requirable (no fabricated capability). */}
        <EvidenceRow
          icon={ICON_SMS}
          label="SMS evidence"
          desc="Declared by provider — execution deferred, so it cannot be required yet."
          statusLabel="Execution deferred"
          statusTone="warn"
          on={false}
          available={false}
          testId="engagement-policy-sms-toggle"
          onToggle={() => undefined}
        />
      </div>

      <div className="eng-card">
        <div className="eng-card__t">Enforcement</div>
        <div className="eng-card__sub">How the policy applies at Submit to client.</div>
        <div
          className="eng-modes"
          role="radiogroup"
          aria-label="Enforcement"
          data-testid="engagement-policy-enforcement"
        >
          {ENFORCEMENT_OPTIONS.map((opt) => {
            const on = enforcementMode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!props.canWrite}
                data-testid={`engagement-policy-mode-${opt.mode}`}
                className={`eng-mode${on ? ' eng-mode--on' : ''}`}
                onClick={() => setEnforcementMode(opt.mode)}
              >
                <span className="eng-mode__dot">
                  <span />
                </span>
                <span>
                  <span className="eng-mode__lb">{opt.label}</span>
                  <span className="eng-mode__desc">{opt.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {props.canWrite && (
        <div className="eng-foot">
          <Button
            variant="primary"
            data-testid="engagement-policy-publish"
            disabled={!canPublish}
            onClick={() => void doPublish()}
          >
            Publish policy
          </Button>
          {/* Draft persistence has no backend yet (publish is the only write) —
              shown for parity, disabled until a draft-save endpoint exists. */}
          <Button
            variant="secondary"
            data-testid="engagement-policy-save-draft"
            disabled
            title="Draft persistence isn’t available yet — publishing is the current save."
          >
            Save draft
          </Button>
          <span className="eng-foot__note">
            Publishing is versioned and logged — active submittals in flight are not retro-blocked.
          </span>
        </div>
      )}
    </div>
  );
}
