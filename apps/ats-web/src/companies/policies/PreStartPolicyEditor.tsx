import { useEffect, useMemo, useState } from 'react';

import { Button, StatusPill } from '../../ui';
import {
  getPreStartHistory,
  getPreStartLayers,
  publishPreStart,
  type PreStartRequirementDef,
  type RequirementProvenance,
} from '../policies-api';

import { PolicySourceBadge } from './PolicySourceBadge';
import { PublishBar } from './PublishBar';
import { PolicyEditorHeader } from './PolicyEditorHeader';

function describeRow(s: { include: boolean; blocking: boolean }): string {
  return s.include ? `Required · ${s.blocking ? 'Blocking' : 'Non-blocking'}` : 'Inherit';
}

// CSP PA-6 — the Pre-Start Policy editor (§20-22). A bounded form over the closed
// requirement-type registry; the authoritative dimensions are Blocking, Waiver mode and
// Satisfaction/verification (exact backend enums, §20). A tenant FLOOR is non-relaxable
// (§21 — the FE disables invalid choices; the resolver + publish guard stay
// authoritative). Publish authors the CLIENT set (draft→publish) then refetches (§31).

type WaiverMode = 'NOT_WAIVABLE' | 'CLIENT_AUTHORITY_ONLY' | 'AUTHORIZED_INTERNAL';
type Satisfaction = 'SELF_ATTEST' | 'VERIFICATION_REQUIRED';

const TYPES = [
  { type: 'BACKGROUND_CHECK', label: 'Background check', desc: 'Criminal and employment history' },
  { type: 'DRUG_SCREEN', label: 'Drug screen', desc: '10-panel screen through the approved vendor' },
  { type: 'I9_VERIFICATION', label: 'I-9 verification', desc: 'Employment eligibility verification' },
  { type: 'CREDENTIAL_VERIFICATION', label: 'Credential verification', desc: 'Degrees and certifications' },
  { type: 'BADGE_PROVISIONING', label: 'Badge provisioning', desc: 'Building access badge issued' },
  { type: 'CLIENT_PAPERWORK', label: 'Client paperwork', desc: 'Client onboarding forms and policies' },
  { type: 'NDA', label: 'NDA', desc: 'Client non-disclosure agreement signed' },
] as const;
type PreStartType = (typeof TYPES)[number]['type'];
const WAIVERS: readonly { mode: WaiverMode; label: string }[] = [
  { mode: 'NOT_WAIVABLE', label: 'Not waivable' },
  { mode: 'CLIENT_AUTHORITY_ONLY', label: 'Client authority' },
  { mode: 'AUTHORIZED_INTERNAL', label: 'Admin' },
];

interface RowState {
  readonly include: boolean;
  readonly blocking: boolean;
  readonly waiver_mode: WaiverMode;
  readonly satisfaction_policy: Satisfaction;
}
interface Loaded {
  readonly floored: ReadonlySet<string>;
  readonly provenance: Partial<Record<string, RequirementProvenance>>;
  readonly nextVersion: string;
}

function byType(defs: readonly PreStartRequirementDef[]): Partial<Record<string, PreStartRequirementDef>> {
  const m: Partial<Record<string, PreStartRequirementDef>> = {};
  for (const d of defs) m[d.requirement_type] = d;
  return m;
}
function rowFrom(client: PreStartRequirementDef | undefined, tenant: PreStartRequirementDef | undefined): RowState {
  const base = client ?? tenant;
  return {
    include: client !== undefined,
    blocking: base?.blocking ?? true,
    waiver_mode: (base?.waiver_mode as WaiverMode) ?? 'AUTHORIZED_INTERNAL',
    satisfaction_policy: (base?.satisfaction_policy as Satisfaction) ?? 'SELF_ATTEST',
  };
}

export function PreStartPolicyEditor({
  companyId,
  onBack,
  onPublished,
}: {
  companyId: string;
  onBack: () => void;
  onPublished?: () => void;
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Record<PreStartType, RowState> | null>(null);
  const [initial, setInitial] = useState<Record<PreStartType, RowState> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const load = useMemo(
    () => async () => {
      const [{ layers }, hist] = await Promise.all([
        getPreStartLayers(companyId),
        getPreStartHistory('CLIENT', companyId),
      ]);
      const tenant = byType(layers.tenant.definitions);
      const client = layers.client?.present ? byType(layers.client.definitions) : {};
      const floored = new Set<string>();
      const provenance: Loaded['provenance'] = {};
      for (const d of layers.effective?.definitions ?? []) {
        provenance[d.requirement_type] = d.provenance;
        if (d.provenance.tenant_floor) floored.add(d.requirement_type);
      }
      const state = {} as Record<PreStartType, RowState>;
      for (const { type } of TYPES) state[type] = rowFrom(client[type], tenant[type]);
      setLoaded({ floored, provenance, nextVersion: nextVersionFrom(hist.versions) });
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

  if (error !== null) return <Shell onBack={onBack}>{<p className="rc-muted-line">{error}</p>}</Shell>;
  if (loaded === null || rows === null || initial === null) return <Shell onBack={onBack}>{null}</Shell>;

  const isChanged = (t: PreStartType): boolean =>
    rows[t].include !== initial[t].include ||
    rows[t].blocking !== initial[t].blocking ||
    rows[t].waiver_mode !== initial[t].waiver_mode ||
    rows[t].satisfaction_policy !== initial[t].satisfaction_policy;
  const changes = TYPES.filter(({ type }) => isChanged(type));

  const patch = (t: PreStartType, p: Partial<RowState>): void => setRows({ ...rows, [t]: { ...rows[t], ...p } });

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const definitions: PreStartRequirementDef[] = TYPES.filter(({ type }) => rows[type].include).map(({ type, label }, i) => ({
        requirement_type: type,
        label,
        blocking: rows[type].blocking,
        owner_role: null,
        sequence: i,
        waiver_mode: rows[type].waiver_mode,
        satisfaction_policy: rows[type].satisfaction_policy,
        override_policy: 'DEFAULT',
      }));
      await publishPreStart({ scope_ref_id: companyId, version: loaded.nextVersion, definitions });
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
      <ul className="rc-editor-rows">
        {TYPES.map(({ type, label, desc }, i) => {
          const isFloor = loaded.floored.has(type);
          const prov = loaded.provenance[type];
          const r = rows[type];
          const editable = r.include && !isFloor;
          return (
            <li key={type} className="rc-prestart-row">
              <div className="rc-prestart-row__head">
                <span className="rc-prestart-row__ord">{i + 1}</span>
                <div className="rc-editor-row__label rc-prestart-row__labelcol">
                  <span className="rc-policy-req__label">{label}</span>
                  <span className="rc-muted-line">{desc}</span>
                </div>
                {isFloor ? <StatusPill tone="brand">Tenant floor</StatusPill> : null}
                {prov !== undefined ? <PolicySourceBadge provenance={prov} /> : null}
                <div className="rc-toggle" role="group" aria-label={`${label} presence`}>
                  <Button unstyled className={!r.include ? 'is-on' : ''} onClick={() => patch(type, { include: false })}>
                    Inherit
                  </Button>
                  <Button unstyled className={r.include ? 'is-on' : ''} onClick={() => patch(type, { include: true })}>
                    Required
                  </Button>
                </div>
              </div>
              {r.include ? (
                <div className="rc-prestart-row__dims">
                  <div className="rc-toggle rc-toggle--sm" role="group" aria-label={`${label} blocking`}>
                    <Button unstyled className={r.blocking ? 'is-on' : ''} disabled={!editable} onClick={() => patch(type, { blocking: true })}>
                      Blocking
                    </Button>
                    <Button unstyled className={!r.blocking ? 'is-on' : ''} disabled={!editable} onClick={() => patch(type, { blocking: false })}>
                      Non-blocking
                    </Button>
                  </div>
                  <div className="rc-toggle rc-toggle--sm" role="group" aria-label={`${label} waiver`}>
                    {WAIVERS.map((w) => (
                      <Button key={w.mode} unstyled className={r.waiver_mode === w.mode ? 'is-on' : ''} disabled={!editable} onClick={() => patch(type, { waiver_mode: w.mode })}>
                        {w.label}
                      </Button>
                    ))}
                  </div>
                  <div className="rc-toggle rc-toggle--sm" role="group" aria-label={`${label} verification`}>
                    <Button unstyled className={r.satisfaction_policy === 'SELF_ATTEST' ? 'is-on' : ''} disabled={!editable} onClick={() => patch(type, { satisfaction_policy: 'SELF_ATTEST' })}>
                      Self-attest
                    </Button>
                    <Button unstyled className={r.satisfaction_policy === 'VERIFICATION_REQUIRED' ? 'is-on' : ''} disabled={!editable} onClick={() => patch(type, { satisfaction_policy: 'VERIFICATION_REQUIRED' })}>
                      Verification required
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <PublishBar
        changes={changes.map(({ type, label }) => `${label}: ${describeRow(initial[type])} → ${describeRow(rows[type])}`)}
        publishing={publishing}
        onCancel={onBack}
        onPublish={() => void publish()}
      />
    </Shell>
  );
}

function nextVersionFrom(versions: readonly { version: string }[]): string {
  return String(versions.reduce((a, v) => Math.max(a, Number.parseInt(v.version, 10) || 0), 0) + 1);
}

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rc-pol">
      <PolicyEditorHeader
        onBack={onBack}
        title="Pre-Start Policy"
        subtitle="What must be complete before a placement can start. A tenant floor cannot be weakened here."
      />
      {children}
    </div>
  );
}
