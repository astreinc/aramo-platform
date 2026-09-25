import { useEffect, useMemo, useState } from 'react';

import { Button, StatusPill } from '../../ui';
import {
  getClientSubmittalHistory,
  getClientSubmittalLayers,
  publishClientSubmittal,
  type ClientSubmittalRequirementDef,
} from '../policies-api';

import { PolicySourceBadge } from './PolicySourceBadge';
import { SUBMITTAL_KEYS, submittalLabel, type SubmittalKey } from './labels';

// CSP PA-4 — the Client Submittal Policy editor (§12). A bounded domain form over the
// canonical requirement keys (§13) — never a generic rule builder (§37). The FE submits
// the CLIENT layer only; the backend merges + enforces the FLOOR (§16, the FE disable is
// UX, not the security boundary). Runtime override is business authority (§15), not a
// generic toggle. After publish it refetches — never trusts a local effective (§31).

type Choice = 'inherit' | 'required' | 'not_required';
type OverrideClass = 'HARD_DENY' | 'OVERRIDABLE';
interface RowState {
  readonly choice: Choice;
  readonly override_class: OverrideClass;
}

interface Loaded {
  readonly tenant: Partial<Record<SubmittalKey, ClientSubmittalRequirementDef>>;
  readonly client: Partial<Record<SubmittalKey, ClientSubmittalRequirementDef>>;
  readonly floored: ReadonlySet<SubmittalKey>;
  readonly provenanceByKey: Partial<Record<SubmittalKey, { inherited: boolean; client_override: boolean; client_added: boolean; tenant_floor: boolean }>>;
  readonly nextVersion: string;
}

function byKey(reqs: readonly ClientSubmittalRequirementDef[]): Partial<Record<SubmittalKey, ClientSubmittalRequirementDef>> {
  const m: Partial<Record<SubmittalKey, ClientSubmittalRequirementDef>> = {};
  for (const r of reqs) if ((SUBMITTAL_KEYS as readonly string[]).includes(r.key)) m[r.key as SubmittalKey] = r;
  return m;
}
function nextVersionFrom(versions: readonly { version: string }[]): string {
  const max = versions.reduce((acc, v) => Math.max(acc, Number.parseInt(v.version, 10) || 0), 0);
  return String(max + 1);
}
function initialRow(client: ClientSubmittalRequirementDef | undefined): RowState {
  if (client === undefined) return { choice: 'inherit', override_class: 'HARD_DENY' };
  return {
    choice: client.disposition === 'REQUIRED' ? 'required' : 'not_required',
    override_class: client.override_class === 'OVERRIDABLE' ? 'OVERRIDABLE' : 'HARD_DENY',
  };
}

export function ClientSubmittalPolicyEditor({
  companyId,
  onBack,
  onPublished,
}: {
  companyId: string;
  onBack: () => void;
  onPublished?: () => void;
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Record<SubmittalKey, RowState> | null>(null);
  const [initial, setInitial] = useState<Record<SubmittalKey, RowState> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const load = useMemo(
    () => async () => {
      const [{ layers }, hist] = await Promise.all([
        getClientSubmittalLayers(companyId),
        getClientSubmittalHistory('CLIENT', companyId),
      ]);
      const tenant = byKey(layers.tenant.requirements);
      const client = layers.client?.present ? byKey(layers.client.requirements) : {};
      const floored = new Set<SubmittalKey>();
      const provenanceByKey: Loaded['provenanceByKey'] = {};
      for (const r of layers.effective?.requirements ?? []) {
        if (!(SUBMITTAL_KEYS as readonly string[]).includes(r.key)) continue;
        provenanceByKey[r.key as SubmittalKey] = r.provenance;
        if (r.provenance.tenant_floor && r.effective.disposition === 'REQUIRED') floored.add(r.key as SubmittalKey);
      }
      const state = {} as Record<SubmittalKey, RowState>;
      for (const k of SUBMITTAL_KEYS) state[k] = initialRow(client[k]);
      setLoaded({ tenant, client, floored, provenanceByKey, nextVersion: nextVersionFrom(hist.versions) });
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

  if (error !== null) return <PanelShell onBack={onBack}>{<p className="rc-muted-line">{error}</p>}</PanelShell>;
  if (loaded === null || rows === null || initial === null) return <PanelShell onBack={onBack}>{null}</PanelShell>;

  const changes = SUBMITTAL_KEYS.filter(
    (k) => rows[k].choice !== initial[k].choice || rows[k].override_class !== initial[k].override_class,
  );

  const setChoice = (k: SubmittalKey, choice: Choice): void => setRows({ ...rows, [k]: { ...rows[k], choice } });
  const setOverride = (k: SubmittalKey, override_class: OverrideClass): void =>
    setRows({ ...rows, [k]: { ...rows[k], override_class } });

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const requirements: ClientSubmittalRequirementDef[] = SUBMITTAL_KEYS.filter((k) => rows[k].choice !== 'inherit').map(
        (k) => ({
          key: k,
          disposition: rows[k].choice === 'required' ? 'REQUIRED' : 'NOT_REQUIRED',
          override_class: rows[k].override_class,
          override_policy: 'DEFAULT',
        }),
      );
      await publishClientSubmittal({ scope: 'CLIENT', scope_ref: companyId, version: loaded.nextVersion, requirements });
      // §31 — never trust a local effective: refetch the authoritative layers.
      await load();
      onPublished?.();
    } catch {
      setError('Publish failed. Your changes were not saved.');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <PanelShell onBack={onBack}>
      <ul className="rc-editor-rows">
        {SUBMITTAL_KEYS.map((k) => {
          const tenant = loaded.tenant[k];
          const isFloor = loaded.floored.has(k);
          const prov = loaded.provenanceByKey[k];
          const tenantSetting = tenant === undefined ? 'not set' : tenant.disposition === 'REQUIRED' ? 'Required' : 'Not required';
          const showOverride = rows[k].choice === 'required';
          return (
            <li key={k} className="rc-editor-row">
              <div className="rc-editor-row__label">
                <span className="rc-policy-req__label">{submittalLabel(k)}</span>
                {isFloor ? <StatusPill tone="brand">Tenant floor</StatusPill> : null}
              </div>
              <div className="rc-toggle" role="group" aria-label={`${submittalLabel(k)} setting`}>
                <Button unstyled className={rows[k].choice === 'inherit' ? 'is-on' : ''} onClick={() => setChoice(k, 'inherit')}>
                  Inherit · {tenantSetting}
                </Button>
                <Button unstyled className={rows[k].choice === 'required' ? 'is-on' : ''} onClick={() => setChoice(k, 'required')}>
                  Required
                </Button>
                <Button
                  unstyled
                  className={rows[k].choice === 'not_required' ? 'is-on' : ''}
                  disabled={isFloor}
                  title={isFloor ? 'Tenant floor — cannot be weakened at client scope' : undefined}
                  onClick={() => setChoice(k, 'not_required')}
                >
                  Not required
                </Button>
              </div>
              <div className="rc-editor-row__src">{prov !== undefined ? <PolicySourceBadge provenance={prov} /> : null}</div>
              <div className="rc-editor-row__ovr">
                {showOverride ? (
                  <div className="rc-toggle rc-toggle--sm" role="group" aria-label={`${submittalLabel(k)} runtime override`}>
                    <Button unstyled className={rows[k].override_class === 'HARD_DENY' ? 'is-on' : ''} onClick={() => setOverride(k, 'HARD_DENY')}>
                      Not allowed
                    </Button>
                    <Button unstyled className={rows[k].override_class === 'OVERRIDABLE' ? 'is-on' : ''} onClick={() => setOverride(k, 'OVERRIDABLE')}>
                      Lead / Admin
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
        <span className="rc-editor-bar__count">
          {changes.length === 0 ? 'No changes yet' : `${changes.length} change${changes.length === 1 ? '' : 's'}`}
        </span>
        <Button variant="secondary" onClick={onBack} disabled={publishing}>
          Cancel
        </Button>
        <Button onClick={() => void publish()} disabled={publishing || changes.length === 0}>
          Publish changes
        </Button>
      </div>
    </PanelShell>
  );
}

function PanelShell({ onBack, children }: { onBack: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rc-policy-detail">
      <div className="rc-policy-detail__head">
        <Button unstyled className="rc-link-action" onClick={onBack}>
          ‹ Policies
        </Button>
        <h3 className="rc-section-h">Client Submittal Policy</h3>
        <p className="rc-muted-line">
          Effective policy = tenant defaults + this client’s changes. A tenant floor cannot be weakened here.
        </p>
      </div>
      {children}
    </div>
  );
}
