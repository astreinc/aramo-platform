import { useCallback, useEffect, useState } from 'react';

import {
  getEngagementCapabilities as defaultLoadCaps,
  getEngagementPolicyState as defaultLoadState,
  publishEngagementPolicy as defaultPublish,
  type EngagementCapability,
  type EngagementEvidenceStrength,
  type EngagementPolicyState,
  type EngagementRequirement,
  type PublishEngagementPolicyInput,
} from './engagement-policy-api';

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
  const publish = props.publishFn ?? defaultPublish;
  const version = props.versionFn ?? (() => `v${Date.now()}`);

  const [state, setState] = useState<EngagementPolicyState | null>(null);
  const [caps, setCaps] = useState<readonly EngagementCapability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [emailRequired, setEmailRequired] = useState(false);
  const [voiceRequired, setVoiceRequired] = useState(false);
  const [voiceStrength, setVoiceStrength] = useState<EngagementEvidenceStrength>('RECRUITER_ATTESTED');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([loadState(), loadCaps()]);
      setState(s);
      setCaps(c);
      setError(null);
    } catch {
      setError('engagement_policy_load_failed');
    }
  }, [loadState, loadCaps]);

  useEffect(() => {
    if (props.canRead) void refresh();
  }, [props.canRead, refresh]);

  const beginEdit = useCallback(() => {
    // Seed the draft from the current effective policy (if any).
    const reqs = state?.effective?.requirements ?? [];
    const email = reqs.find((r) => r.channel === 'email');
    const voice = reqs.find((r) => r.channel === 'voice');
    setEmailRequired(email?.required === true);
    setVoiceRequired(voice?.required === true);
    setVoiceStrength(voice?.channel === 'voice' ? voice.minimum_strength : 'RECRUITER_ATTESTED');
    setConfirming(false);
    setEditing(true);
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
      await publish({ version: version(), scope: 'TENANT', schema_version: 1, requirements });
      setEditing(false);
      setConfirming(false);
      await refresh();
    } catch {
      setError('engagement_policy_publish_failed');
    } finally {
      setBusy(false);
    }
  }, [emailRequired, voiceRequired, voiceStrength, publish, version, refresh]);

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
  const capOf = (ch: 'email' | 'voice'): boolean => caps.find((c) => c.channel === ch)?.available ?? false;

  return (
    <div data-testid="engagement-policy-panel">
      <h3>Engagement Policy</h3>

      {status === 'not_configured' && (
        <div data-testid="engagement-policy-status-not-configured">
          <p><strong>Status: Not configured</strong></p>
          <p>No engagement requirements are currently enforced before Submit to Client.</p>
        </div>
      )}
      {status === 'no_active_policy' && (
        <div data-testid="engagement-policy-status-no-active">
          <p><strong>Status: No active policy</strong></p>
          <p>This tenant is governed but has no effective policy; Submit to Client fails closed until a policy is effective.</p>
        </div>
      )}
      {status === 'published' && state.effective !== null && (
        <div data-testid="engagement-policy-status-published">
          <p><strong>Status: Published — enforcing</strong></p>
          <p>Recruiters must satisfy these requirements before Submit to Client:</p>
          <ul>
            {state.effective.requirements
              .filter((r) => r.required)
              .map((r) => (
                <li key={r.channel} data-testid={`engagement-policy-req-${r.channel}`}>
                  {r.channel === 'email'
                    ? 'Email evidence required — a provider-accepted outbound send must be on record.'
                    : `Voice conversation required (two-way; minimum strength ${r.minimum_strength}).`}
                </li>
              ))}
          </ul>
          <p data-testid="engagement-policy-effective-version">Effective version: {state.effective.composite_version}</p>
        </div>
      )}

      <dl>
        <dt>Email evidence</dt>
        <dd data-testid="engagement-cap-email">{capOf('email') ? 'Available' : 'Unavailable'}</dd>
        <dt>Voice evidence</dt>
        <dd data-testid="engagement-cap-voice">{capOf('voice') ? 'Available' : 'Unavailable'}</dd>
      </dl>

      {!props.canWrite && (
        <p data-testid="engagement-policy-readonly">Read-only — you do not have permission to edit this policy.</p>
      )}

      {props.canWrite && !editing && (
        <button type="button" data-testid="engagement-policy-configure" onClick={beginEdit}>
          {status === 'not_configured' ? 'Configure Policy' : 'Edit Policy'}
        </button>
      )}

      {props.canWrite && editing && (
        <div data-testid="engagement-policy-draft">
          <p><strong>Draft (not enforced until published)</strong></p>
          <label>
            <input
              type="checkbox"
              data-testid="engagement-policy-email-toggle"
              checked={emailRequired}
              onChange={(e) => setEmailRequired(e.target.checked)}
            />
            Require Email Evidence
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="engagement-policy-voice-toggle"
              checked={voiceRequired}
              onChange={(e) => setVoiceRequired(e.target.checked)}
            />
            Require Voice Conversation
          </label>
          {voiceRequired && (
            <label>
              Minimum voice evidence strength
              <select
                data-testid="engagement-policy-voice-strength"
                value={voiceStrength}
                onChange={(e) => setVoiceStrength(e.target.value as EngagementEvidenceStrength)}
              >
                <option value="RECRUITER_ATTESTED">Recruiter attested</option>
                <option value="PROVIDER_VERIFIED">Provider verified</option>
              </select>
            </label>
          )}

          {!confirming && (
            <div>
              <button
                type="button"
                data-testid="engagement-policy-review"
                disabled={!emailRequired && !voiceRequired}
                onClick={() => setConfirming(true)}
              >
                Review &amp; Publish
              </button>
              <button type="button" data-testid="engagement-policy-cancel" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          )}

          {confirming && (
            <div data-testid="engagement-policy-publish-warning">
              <p>
                Publishing this policy will enforce these engagement requirements when recruiters
                submit Talent to a client. Recruiters will be blocked from Submit to Client until the
                required evidence exists.
              </p>
              <button type="button" data-testid="engagement-policy-publish" disabled={busy} onClick={doPublish}>
                Publish
              </button>
              <button type="button" data-testid="engagement-policy-publish-back" onClick={() => setConfirming(false)}>
                Back
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
