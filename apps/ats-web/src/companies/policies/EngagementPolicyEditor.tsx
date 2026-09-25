import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../ui';
import {
  getEngagementHistory,
  getEngagementLayers,
  publishEngagement,
  type EngagementEnforcementMode,
  type EngagementRequirementDef,
  type RequirementProvenance,
} from '../policies-api';

import { PolicySourceBadge } from './PolicySourceBadge';
import { engagementLabel } from './labels';

// CSP PA-5 — the Engagement Policy editor (§18/§19). A bounded form over the executable
// channels ONLY (voice + email); there is NO generic "+ Add requirement". Engagement has
// no per-requirement floor (§19); the runtime-override authority is the POLICY-level
// enforcement_mode (§15). The FE authors the CLIENT layer and refetches after publish (§31).

type Channel = 'voice' | 'email';
type Choice = 'inherit' | 'required' | 'not_required';
type Strength = 'RECRUITER_ATTESTED' | 'PROVIDER_VERIFIED';

const CHANNELS: readonly { channel: Channel; condition: string }[] = [
  { channel: 'voice', condition: 'two_way_conversation' },
  { channel: 'email', condition: 'recorded_evidence' },
];
const ENFORCEMENT: readonly { mode: EngagementEnforcementMode; label: string }[] = [
  { mode: 'ADVISORY', label: 'Advisory' },
  { mode: 'ENFORCING', label: 'Enforcing' },
  { mode: 'ENFORCING_WITH_OVERRIDE', label: 'Enforcing · Lead / Admin' },
];

interface ChannelState {
  readonly choice: Choice;
  readonly minimum_strength: Strength;
}
interface Loaded {
  readonly tenant: Partial<Record<Channel, EngagementRequirementDef>>;
  readonly provenance: Partial<Record<Channel, RequirementProvenance>>;
  readonly nextVersion: string;
}

function byChannel(reqs: readonly EngagementRequirementDef[]): Partial<Record<Channel, EngagementRequirementDef>> {
  const m: Partial<Record<Channel, EngagementRequirementDef>> = {};
  for (const r of reqs) m[r.channel] = r;
  return m;
}
function nextVersionFrom(versions: readonly { version: string }[]): string {
  return String(versions.reduce((a, v) => Math.max(a, Number.parseInt(v.version, 10) || 0), 0) + 1);
}
function initialChannel(client: EngagementRequirementDef | undefined): ChannelState {
  if (client === undefined) return { choice: 'inherit', minimum_strength: 'RECRUITER_ATTESTED' };
  return {
    choice: client.required ? 'required' : 'not_required',
    minimum_strength: client.minimum_strength ?? 'RECRUITER_ATTESTED',
  };
}

export function EngagementPolicyEditor({
  companyId,
  onBack,
  onPublished,
}: {
  companyId: string;
  onBack: () => void;
  onPublished?: () => void;
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [channels, setChannels] = useState<Record<Channel, ChannelState> | null>(null);
  const [mode, setMode] = useState<EngagementEnforcementMode>('ENFORCING');
  const [initial, setInitial] = useState<{ channels: Record<Channel, ChannelState>; mode: EngagementEnforcementMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const load = useMemo(
    () => async () => {
      const [{ layers }, hist] = await Promise.all([
        getEngagementLayers(companyId),
        getEngagementHistory('CLIENT', companyId),
      ]);
      const tenant = byChannel(layers.tenant.requirements);
      const client = layers.client?.present ? byChannel(layers.client.requirements) : {};
      const provenance: Loaded['provenance'] = {};
      for (const r of layers.effective?.requirements ?? []) provenance[r.channel] = r.provenance;
      const state = {
        voice: initialChannel(client.voice),
        email: initialChannel(client.email),
      } as Record<Channel, ChannelState>;
      const m = layers.client?.enforcement_mode ?? layers.effective?.enforcement_mode ?? 'ENFORCING';
      setLoaded({ tenant, provenance, nextVersion: nextVersionFrom(hist.versions) });
      setChannels(state);
      setMode(m);
      setInitial({ channels: state, mode: m });
    },
    [companyId],
  );

  useEffect(() => {
    let live = true;
    load().catch(() => {
      if (live) setError('Policy could not be loaded.');
    });
    return () => {
      live = false;
    };
  }, [load]);

  if (error !== null) return <Shell onBack={onBack}>{<p className="rc-muted-line">{error}</p>}</Shell>;
  if (loaded === null || channels === null || initial === null) return <Shell onBack={onBack}>{null}</Shell>;

  const changed =
    mode !== initial.mode ||
    CHANNELS.some(
      ({ channel }) =>
        channels[channel].choice !== initial.channels[channel].choice ||
        channels[channel].minimum_strength !== initial.channels[channel].minimum_strength,
    );

  const setChoice = (ch: Channel, choice: Choice): void => setChannels({ ...channels, [ch]: { ...channels[ch], choice } });
  const setStrength = (ch: Channel, minimum_strength: Strength): void =>
    setChannels({ ...channels, [ch]: { ...channels[ch], minimum_strength } });

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const requirements: EngagementRequirementDef[] = CHANNELS.filter(({ channel }) => channels[channel].choice !== 'inherit').map(
        ({ channel, condition }) =>
          channel === 'voice'
            ? { channel, required: channels[channel].choice === 'required', condition, minimum_strength: channels[channel].minimum_strength }
            : { channel, required: channels[channel].choice === 'required', condition },
      );
      await publishEngagement({
        scope: 'CLIENT',
        scope_ref: companyId,
        version: loaded.nextVersion,
        schema_version: 1,
        requirements,
        enforcement_mode: mode,
      });
      await load();
      onPublished?.();
    } catch {
      setError('Publish failed. Your changes were not saved.');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Shell onBack={onBack}>
      <div className="rc-enf">
        <span className="rc-policy-req__label">Enforcement</span>
        <div className="rc-toggle" role="group" aria-label="Enforcement mode">
          {ENFORCEMENT.map((e) => (
            <Button key={e.mode} unstyled className={mode === e.mode ? 'is-on' : ''} onClick={() => setMode(e.mode)}>
              {e.label}
            </Button>
          ))}
        </div>
      </div>
      <ul className="rc-editor-rows">
        {CHANNELS.map(({ channel }) => {
          const tenant = loaded.tenant[channel];
          const prov = loaded.provenance[channel];
          const tenantSetting = tenant === undefined ? 'not set' : tenant.required ? 'Required' : 'Not required';
          return (
            <li key={channel} className="rc-editor-row">
              <div className="rc-editor-row__label">
                <span className="rc-policy-req__label">{engagementLabel(channel)}</span>
              </div>
              <div className="rc-toggle" role="group" aria-label={`${engagementLabel(channel)} setting`}>
                <Button unstyled className={channels[channel].choice === 'inherit' ? 'is-on' : ''} onClick={() => setChoice(channel, 'inherit')}>
                  Inherit · {tenantSetting}
                </Button>
                <Button unstyled className={channels[channel].choice === 'required' ? 'is-on' : ''} onClick={() => setChoice(channel, 'required')}>
                  Required
                </Button>
                <Button unstyled className={channels[channel].choice === 'not_required' ? 'is-on' : ''} onClick={() => setChoice(channel, 'not_required')}>
                  Not required
                </Button>
              </div>
              <div className="rc-editor-row__src">{prov !== undefined ? <PolicySourceBadge provenance={prov} /> : null}</div>
              <div className="rc-editor-row__ovr">
                {channel === 'voice' && channels.voice.choice === 'required' ? (
                  <div className="rc-toggle rc-toggle--sm" role="group" aria-label="Voice minimum strength">
                    <Button unstyled className={channels.voice.minimum_strength === 'RECRUITER_ATTESTED' ? 'is-on' : ''} onClick={() => setStrength('voice', 'RECRUITER_ATTESTED')}>
                      Recruiter-attested
                    </Button>
                    <Button unstyled className={channels.voice.minimum_strength === 'PROVIDER_VERIFIED' ? 'is-on' : ''} onClick={() => setStrength('voice', 'PROVIDER_VERIFIED')}>
                      Provider-verified
                    </Button>
                  </div>
                ) : (
                  <span className="rc-muted-line">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="rc-editor-bar">
        <span className="rc-editor-bar__count">{changed ? 'Unsaved changes' : 'No changes yet'}</span>
        <Button variant="secondary" onClick={onBack} disabled={publishing}>
          Cancel
        </Button>
        <Button onClick={() => void publish()} disabled={publishing || !changed}>
          Publish changes
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rc-policy-detail">
      <div className="rc-policy-detail__head">
        <Button unstyled className="rc-link-action" onClick={onBack}>
          ‹ Policies
        </Button>
        <h3 className="rc-section-h">Engagement Policy</h3>
        <p className="rc-muted-line">Communication evidence required before client submittal. Voice and email only.</p>
      </div>
      {children}
    </div>
  );
}
