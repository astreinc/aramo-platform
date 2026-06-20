import { useEffect, useMemo, useState } from 'react';

import { Card, InlineAlert, StatusPill } from '../../ui';
import { SettingHint } from '../components';

import { fetchRolesCatalog, type RoleCatalogView } from './roles-catalog-api';

// Settings Rebuild Directive 5 — the Roles & permissions matrix (READ-ONLY).
//
// A populated, legible view of the system roles × their scopes, sourced from
// the roles-catalog GET. THE READ-ONLY POSTURE IS A SAFETY CONSTRAINT, not a
// scope cut: the role bundles encode invariants (D5 non-invertibility, the S4
// gate) that an editable matrix could violate. So this DISPLAYS the model — it
// has NO edit / assign / revoke affordance. Editable/custom roles are a future
// milestone with enforcement at the mutation boundary.

// Scope domain (first segment) → a readable category label. Unknown domains
// humanize their segment. Pure presentation grouping — no scope math.
const CATEGORY_LABEL: Record<string, string> = {
  talent: 'Talent',
  company: 'Companies',
  contact: 'Contacts',
  requisition: 'Requisitions',
  submittal: 'Submittals',
  engagement: 'Engagement',
  pipeline: 'Pipeline',
  compensation: 'Compensation',
  calendar: 'Calendar',
  activity: 'Activity',
  examination: 'Examination',
  attachment: 'Attachments',
  import: 'Data',
  export: 'Data',
  audit: 'Audit',
  consent: 'Consent',
  auth: 'Sessions',
  identity: 'Identity',
  org: 'Teams & org',
  team: 'Teams & org',
  dashboard: 'Reporting',
  report: 'Reporting',
  tenant: 'Administration',
  portal: 'Portal',
};

function categoryOf(scope: string): string {
  const seg = scope.split(':')[0] ?? scope;
  return CATEGORY_LABEL[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}

interface ScopeGroup {
  readonly category: string;
  readonly scopes: readonly string[];
}

function groupScopes(scopes: readonly string[]): ScopeGroup[] {
  const byCat = new Map<string, string[]>();
  for (const s of scopes) {
    const cat = categoryOf(s);
    const list = byCat.get(cat) ?? [];
    list.push(s);
    byCat.set(cat, list);
  }
  return [...byCat.entries()]
    .map(([category, list]) => ({ category, scopes: list.sort() }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

interface Props {
  readonly fetchFn?: () => Promise<readonly RoleCatalogView[]>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; roles: readonly RoleCatalogView[] }
  | { status: 'error'; message: string };

export function RolesMatrixView({ fetchFn }: Props = {}) {
  const load = fetchFn ?? fetchRolesCatalog;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((roles) => {
        if (cancelled) return;
        setState({ status: 'ready', roles });
        setSelectedKey(roles[0]?.key ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load the roles catalog.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const selected = useMemo(() => {
    if (state.status !== 'ready') return null;
    return state.roles.find((r) => r.key === selectedKey) ?? state.roles[0] ?? null;
  }, [state, selectedKey]);

  const groupsByTier = useMemo(() => {
    if (state.status !== 'ready') return [] as { tier: string; roles: RoleCatalogView[] }[];
    const byTier: { tier: string; roles: RoleCatalogView[] }[] = [];
    for (const r of state.roles) {
      const last = byTier[byTier.length - 1];
      if (last && last.tier === r.tier) last.roles.push(r);
      else byTier.push({ tier: r.tier, roles: [r] });
    }
    return byTier;
  }, [state]);

  if (state.status === 'loading') {
    return <p className="set-muted">Loading roles…</p>;
  }
  if (state.status === 'error') {
    return <InlineAlert variant="error">{state.message}</InlineAlert>;
  }

  return (
    <>
      <div className="rc-roles-matrix">
        <nav className="rc-roles-list" aria-label="System roles">
          {groupsByTier.map((g) => (
            <div key={g.tier}>
              <div className="rc-roles-list__tier">{g.tier}</div>
              {g.roles.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`rc-roles-list__item${r.key === selected?.key ? ' on' : ''}`}
                  aria-current={r.key === selected?.key ? 'true' : undefined}
                  onClick={() => setSelectedKey(r.key)}
                  data-testid={`role-item-${r.key}`}
                >
                  <span className="rc-roles-list__name">{r.display}</span>
                  <span className="rc-roles-list__count">{r.scopes.length}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {selected ? (
          <Card flush>
            <div className="rc-card--pad">
              <div className="rc-role-brief__head">
                <h3>{selected.display}</h3>
                <StatusPill tone="neutral">{selected.tier}</StatusPill>
                {selected.requires_setting ? (
                  <StatusPill tone="warn">Settings-gated</StatusPill>
                ) : null}
              </div>
              <p className="set-muted" style={{ paddingTop: 0 }}>
                {selected.description}
              </p>
              {selected.scopes.length === 0 ? (
                <p className="set-muted">This role holds no scopes.</p>
              ) : (
                <div className="rc-role-brief__groups" data-testid={`role-scopes-${selected.key}`}>
                  {groupScopes(selected.scopes).map((grp) => (
                    <div className="rc-role-brief__group" key={grp.category}>
                      <div className="rc-role-brief__cat">{grp.category}</div>
                      <ul className="rc-role-brief__scopes">
                        {grp.scopes.map((s) => (
                          <li key={s} className="mono">
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        ) : null}
      </div>

      <SettingHint>
        This is a read-only view of the permission model. Role bundles encode
        safety invariants (a manager who sees rate spreads can never be
        configured to also see pay), so they are not editable here — editable
        and custom roles are a future capability with those guarantees enforced
        at the write boundary.
      </SettingHint>
      <SettingHint>
        Roles are global system roles — the same for every workspace.
      </SettingHint>
    </>
  );
}
