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

import { AddRequirementButton } from './AddRequirementButton';
import { PolicySourceBadge } from './PolicySourceBadge';
import { PublishBar } from './PublishBar';
import { PolicyEditorHeader } from './PolicyEditorHeader';
import { detailSubtitle, engagementLabel } from './labels';

// CSP PA-5 — the Engagement Policy editor (§18/§19). Executable channels ONLY
// (voice + email). Rendered as the prototype's 4-column table. Runtime override is
// engagement's POLICY-level enforcement_mode surfaced per required channel (Not allowed
// = ENFORCING · Lead/Admin = ENFORCING_WITH_OVERRIDE); on publish the policy mode is
// ENFORCING_WITH_OVERRIDE iff any required channel allows override. Publishes the CLIENT
// layer and refetches (§31).

type Channel = 'voice' | 'email';
type Choice = 'inherit' | 'required' | 'not_required';

const CHANNELS: readonly { channel: Channel; condition: string; desc: string }[] = [
  { channel: 'email', condition: 'recorded_evidence', desc: 'Logged email engagement with the talent before submittal' },
  { channel: 'voice', condition: 'two_way_conversation', desc: 'Logged voice engagement (call or meeting) with the talent' },
];

interface ChannelState {
  readonly choice: Choice;
  readonly override: boolean;
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
function initialChannel(client: EngagementRequirementDef | undefined, override: boolean): ChannelState {
  if (client === undefined) return { choice: 'inherit', override };
  return { choice: client.required ? 'required' : 'not_required', override };
}

export function EngagementPolicyEditor({
  companyId,
  companyName,
  onBack,
  onPreview,
  onPublished,
}: {
  companyId: string;
  companyName?: string;
  onBack: () => void;
  onPreview?: () => void;
  onPublished?: () => void;
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Record<Channel, ChannelState> | null>(null);
  const [initial, setInitial] = useState<Record<Channel, ChannelState> | null>(null);
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
      const overrideOn = (layers.client?.enforcement_mode ?? layers.effective?.enforcement_mode) === 'ENFORCING_WITH_OVERRIDE';
      const state = {
        email: initialChannel(client.email, overrideOn),
        voice: initialChannel(client.voice, overrideOn),
      } as Record<Channel, ChannelState>;
      setLoaded({ tenant, provenance, nextVersion: nextVersionFrom(hist.versions) });
      setRows(state);
      setInitial(state);
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

  const subtitle = detailSubtitle(companyName, loaded?.nextVersion);
  if (error !== null) return <Shell onBack={onBack} subtitle={subtitle}>{<p className="rc-muted-line">{error}</p>}</Shell>;
  if (loaded === null || rows === null || initial === null) return <Shell onBack={onBack} subtitle={subtitle}>{null}</Shell>;

  const changedChannels = CHANNELS.filter(
    ({ channel }) => rows[channel].choice !== initial[channel].choice || rows[channel].override !== initial[channel].override,
  );
  const setChoice = (ch: Channel, choice: Choice): void => setRows({ ...rows, [ch]: { ...rows[ch], choice } });
  const setOverride = (ch: Channel, override: boolean): void => setRows({ ...rows, [ch]: { ...rows[ch], override } });

  const describe = (s: ChannelState): string =>
    s.choice === 'inherit' ? 'Inherit' : s.choice === 'required' ? `Required (${s.override ? 'Lead / Admin' : 'Not allowed'})` : 'Not required';
  const summaries = changedChannels.map(
    ({ channel }) => `${engagementLabel(channel)}: ${describe(initial[channel])} → ${describe(rows[channel])}`,
  );

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const requirements: EngagementRequirementDef[] = CHANNELS.filter(({ channel }) => rows[channel].choice !== 'inherit').map(
        ({ channel, condition }) =>
          channel === 'voice'
            ? { channel, required: rows[channel].choice === 'required', condition, minimum_strength: 'RECRUITER_ATTESTED' }
            : { channel, required: rows[channel].choice === 'required', condition },
      );
      const enforcement: EngagementEnforcementMode = CHANNELS.some(
        ({ channel }) => rows[channel].choice === 'required' && rows[channel].override,
      )
        ? 'ENFORCING_WITH_OVERRIDE'
        : 'ENFORCING';
      await publishEngagement({
        scope: 'CLIENT',
        scope_ref: companyId,
        version: loaded.nextVersion,
        schema_version: 1,
        requirements,
        enforcement_mode: enforcement,
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
    <Shell onBack={onBack} subtitle={subtitle}>
      <div className="rc-editor-card">
        <div className="rc-editor-head">
          <span>Requirement</span>
          <span>Requirement setting</span>
          <span>Policy source</span>
          <span>Runtime override</span>
        </div>
        <ul className="rc-editor-rows">
          {CHANNELS.map(({ channel, desc }) => {
            const tenant = loaded.tenant[channel];
            const prov = loaded.provenance[channel];
            const label = engagementLabel(channel);
            const tenantSetting = tenant === undefined ? 'not set' : tenant.required ? 'Required' : 'Not required';
            const clientSetting = rows[channel].choice === 'required' ? 'Required' : rows[channel].choice === 'not_required' ? 'Not required' : 'Inherit';
            // the runtime override applies whenever the EFFECTIVE setting is Required —
            // including an inherited-required channel (prototype `ovApplies`).
            const effectiveRequired =
              rows[channel].choice === 'required' || (rows[channel].choice === 'inherit' && tenant?.required === true);
            const showOverride = effectiveRequired;
            const delta =
              tenant === undefined
                ? 'Not in tenant defaults · added for this client'
                : rows[channel].choice === 'inherit'
                  ? `Follows tenant default (${tenantSetting})`
                  : `Tenant: ${tenantSetting} → Client: ${clientSetting}`;
            const deltaChanged = tenant !== undefined && rows[channel].choice !== 'inherit' && clientSetting !== tenantSetting;
            return (
              <li key={channel} className="rc-editor-row">
                <div className="rc-editor-row__label">
                  <span className="rc-policy-req__label">{label}</span>
                  <span className="rc-muted-line">{desc}</span>
                </div>
                <div className="rc-editor-row__setting">
                  <div className="rc-toggle" role="group" aria-label={`${label} setting`}>
                    <Button unstyled className={rows[channel].choice === 'inherit' ? 'is-on' : ''} onClick={() => setChoice(channel, 'inherit')}>
                      Inherit · {tenantSetting}
                    </Button>
                    <Button unstyled className={rows[channel].choice === 'required' ? 'is-on' : ''} onClick={() => setChoice(channel, 'required')}>
                      Required
                    </Button>
                    <Button unstyled className={rows[channel].choice === 'not_required' ? 'is-on' : ''} onClick={() => setChoice(channel, 'not_required')}>
                      Not required
                    </Button>
                  </div>
                  <span className={`rc-delta${deltaChanged ? ' rc-delta--changed' : ''}`}>{delta}</span>
                </div>
                <div className="rc-editor-row__src">{prov !== undefined ? <PolicySourceBadge provenance={prov} /> : null}</div>
                <div className="rc-editor-row__ovr">
                  {showOverride ? (
                    <div className="rc-toggle rc-toggle--sm" role="group" aria-label={`${label} runtime override`}>
                      <Button unstyled className={!rows[channel].override ? 'is-on' : ''} onClick={() => setOverride(channel, false)}>
                        Not allowed
                      </Button>
                      <Button unstyled className={rows[channel].override ? 'is-on' : ''} onClick={() => setOverride(channel, true)}>
                        Lead / Admin
                      </Button>
                    </div>
                  ) : (
                    <span className="rc-muted-line">— not required</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <AddRequirementButton catalog={[]} emptyText="Engagement evidence covers voice and email — the only channels Aramo can verify today." />
      </div>
      <PublishBar
        changes={summaries}
        publishing={publishing}
        title="Engagement Policy"
        nextVersion={loaded.nextVersion}
        onCancel={onBack}
        onPreview={onPreview}
        onPublish={() => void publish()}
      />
    </Shell>
  );
}

function Shell({ onBack, subtitle, children }: { onBack: () => void; subtitle: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rc-pol">
      <PolicyEditorHeader onBack={onBack} title="Engagement Policy" subtitle={subtitle} />
      {children}
    </div>
  );
}
