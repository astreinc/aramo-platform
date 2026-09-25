import { useEffect, useMemo, useState } from 'react';
import { Select } from '@aramo/fe-foundation';

import { Button } from '../../ui';
import {
  getPreStartHistory,
  getPreStartLayers,
  publishPreStart,
  type PreStartRequirementDef,
  type RequirementProvenance,
} from '../policies-api';

import { AddRequirementButton } from './AddRequirementButton';
import { PolicySourceBadge } from './PolicySourceBadge';
import { PublishBar } from './PublishBar';
import { PolicyEditorHeader } from './PolicyEditorHeader';
import { detailSubtitle } from './labels';

function describeRow(s: { include: boolean; blocking: boolean }): string {
  return s.include ? `Required · ${s.blocking ? 'Blocking' : 'Non-blocking'}` : 'Inherit';
}

// CSP PA-6 — the Pre-Start Policy editor (§20-22). A bounded form over the closed
// requirement-type registry, rendered as the prototype's ordered checklist cards. The
// authoritative dimensions are Blocking, Waiver mode and Satisfaction/verification (exact
// backend enums, §20). A tenant FLOOR is non-relaxable (§21 — the FE locks invalid
// choices; the resolver + publish guard stay authoritative). Publish authors the CLIENT
// set (draft→publish) then refetches (§31).

type WaiverMode = 'NOT_WAIVABLE' | 'AUTHORIZED_INTERNAL';
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
const LABELS: Record<PreStartType, { label: string; desc: string }> = TYPES.reduce(
  (m, t) => ({ ...m, [t.type]: { label: t.label, desc: t.desc } }),
  {} as Record<PreStartType, { label: string; desc: string }>,
);

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
function orderFrom(defs: readonly PreStartRequirementDef[]): PreStartType[] {
  const seen = defs
    .filter((d) => (TYPES as readonly { type: string }[]).some((t) => t.type === d.requirement_type))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((d) => d.requirement_type as PreStartType);
  const rest = TYPES.map((t) => t.type).filter((t) => !seen.includes(t));
  return [...seen, ...rest];
}
function rowFrom(client: PreStartRequirementDef | undefined, tenant: PreStartRequirementDef | undefined): RowState {
  const base = client ?? tenant;
  const waiver = base?.waiver_mode === 'NOT_WAIVABLE' ? 'NOT_WAIVABLE' : 'AUTHORIZED_INTERNAL';
  return {
    include: client !== undefined,
    blocking: base?.blocking ?? true,
    waiver_mode: waiver,
    satisfaction_policy: (base?.satisfaction_policy as Satisfaction) ?? 'VERIFICATION_REQUIRED',
  };
}

export function PreStartPolicyEditor({
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
  const [rows, setRows] = useState<Record<PreStartType, RowState> | null>(null);
  const [initial, setInitial] = useState<Record<PreStartType, RowState> | null>(null);
  const [order, setOrder] = useState<PreStartType[] | null>(null);
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
      setOrder(orderFrom(layers.effective?.definitions ?? []));
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
  if (loaded === null || rows === null || initial === null || order === null)
    return <Shell onBack={onBack} subtitle={subtitle}>{null}</Shell>;

  const isChanged = (t: PreStartType): boolean =>
    rows[t].include !== initial[t].include ||
    rows[t].blocking !== initial[t].blocking ||
    rows[t].waiver_mode !== initial[t].waiver_mode ||
    rows[t].satisfaction_policy !== initial[t].satisfaction_policy;
  const changes = TYPES.filter(({ type }) => isChanged(type));

  const patch = (t: PreStartType, p: Partial<RowState>): void => setRows({ ...rows, [t]: { ...rows[t], ...p } });
  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    const a = next[i];
    const b = next[j];
    if (a === undefined || b === undefined) return;
    next[i] = b;
    next[j] = a;
    setOrder(next);
  };

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const definitions: PreStartRequirementDef[] = order
        .filter((type) => rows[type].include)
        .map((type, i) => ({
          requirement_type: type,
          label: LABELS[type].label,
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
    <Shell onBack={onBack} subtitle={subtitle}>
      <div className="rc-pre">
        {order.map((type, i) => {
          const isFloor = loaded.floored.has(type);
          const prov = loaded.provenance[type];
          const r = rows[type];
          const editable = r.include && !isFloor;
          const meta = LABELS[type];
          const tenantDelta = isFloor
            ? 'Tenant floor — cannot be weakened here'
            : r.include
              ? describeRow(r)
              : 'Inherits tenant default';
          return (
            <div key={type} className="rc-pre-card">
              <div className="rc-pre-card__head">
                <span className="rc-pre-card__arrows">
                  <Button unstyled className="rc-pre-card__arrow" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M18 15l-6-6-6 6" />
                    </svg>
                  </Button>
                  <Button
                    unstyled
                    className="rc-pre-card__arrow"
                    aria-label="Move later"
                    disabled={i === order.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </Button>
                </span>
                <span className="rc-pre-card__ord">{i + 1}</span>
                <span className="rc-pre-card__title">
                  <span className="rc-pre-card__label">{meta.label}</span>
                  <span className="rc-muted-line">{meta.desc}</span>
                </span>
                {isFloor ? (
                  <span className="rc-floor-pill" title="Tenant floor — cannot be weakened at client or requisition scope">
                    <LockGlyph />
                    Tenant floor
                  </span>
                ) : null}
                {prov !== undefined ? <PolicySourceBadge provenance={prov} /> : null}
              </div>
              <div className="rc-pre-card__dims">
                {isFloor ? (
                  <span className="rc-locked-chip">
                    <LockGlyph />
                    Required
                  </span>
                ) : (
                  <div className="rc-toggle rc-toggle--sm" role="group" aria-label={`${meta.label} presence`}>
                    <Button unstyled className={!r.include ? 'is-on' : ''} onClick={() => patch(type, { include: false })}>
                      Inherit
                    </Button>
                    <Button unstyled className={r.include ? 'is-on' : ''} onClick={() => patch(type, { include: true })}>
                      Required
                    </Button>
                  </div>
                )}
                {r.include ? (
                  <span className="rc-pre-card__selects">
                    <Select
                      unstyled
                      className="rc-select"
                      aria-label={`${meta.label} blocking`}
                      value={r.blocking ? 'Blocking' : 'Non-blocking'}
                      disabled={!editable}
                      onChange={(e) => patch(type, { blocking: e.target.value === 'Blocking' })}
                    >
                      <option>Blocking</option>
                      <option>Non-blocking</option>
                    </Select>
                    <Select
                      unstyled
                      className="rc-select"
                      aria-label={`${meta.label} waiver`}
                      value={r.waiver_mode === 'NOT_WAIVABLE' ? 'Not waivable' : 'Waivable by admin'}
                      disabled={!editable}
                      onChange={(e) => patch(type, { waiver_mode: e.target.value === 'Not waivable' ? 'NOT_WAIVABLE' : 'AUTHORIZED_INTERNAL' })}
                    >
                      <option>Not waivable</option>
                      <option>Waivable by admin</option>
                    </Select>
                    <Select
                      unstyled
                      className="rc-select"
                      aria-label={`${meta.label} verification`}
                      value={r.satisfaction_policy === 'VERIFICATION_REQUIRED' ? 'Verification required' : 'Self-attested'}
                      disabled={!editable}
                      onChange={(e) =>
                        patch(type, { satisfaction_policy: e.target.value === 'Verification required' ? 'VERIFICATION_REQUIRED' : 'SELF_ATTEST' })
                      }
                    >
                      <option>Verification required</option>
                      <option>Self-attested</option>
                    </Select>
                  </span>
                ) : null}
                <span className="rc-pre-card__delta">{tenantDelta}</span>
              </div>
            </div>
          );
        })}
      </div>
      <AddRequirementButton catalog={[]} emptyText="Every Pre-Start requirement Aramo can verify today is already shown for this client." />
      <p className="rc-footnote">
        Order sets the sequence of the Pre-Start checklist. Blocking requirements must be complete before the start date can be
        confirmed.
      </p>
      <PublishBar
        changes={changes.map(({ type, label }) => `${label}: ${describeRow(initial[type])} → ${describeRow(rows[type])}`)}
        publishing={publishing}
        title="Pre-Start Policy"
        nextVersion={loaded.nextVersion}
        onCancel={onBack}
        onPreview={onPreview}
        onPublish={() => void publish()}
      />
    </Shell>
  );
}

function LockGlyph(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function nextVersionFrom(versions: readonly { version: string }[]): string {
  return String(versions.reduce((a, v) => Math.max(a, Number.parseInt(v.version, 10) || 0), 0) + 1);
}

function Shell({ onBack, subtitle, children }: { onBack: () => void; subtitle: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rc-pol">
      <PolicyEditorHeader onBack={onBack} title="Pre-Start Policy" subtitle={subtitle} />
      {children}
    </div>
  );
}
