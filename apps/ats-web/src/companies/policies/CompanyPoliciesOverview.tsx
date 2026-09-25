import { useEffect, useState } from 'react';

import { Card, StatusPill, Button } from '../../ui';
import {
  getClientSubmittalEffective,
  getClientSubmittalHistory,
  getEngagementEffective,
  getEngagementHistory,
  getPreStartEffective,
  getPreStartHistory,
  type ClientSubmittalEffectiveView,
  type EngagementEffectiveView,
  type PreStartEffectiveView,
  type RequirementProvenance,
} from '../policies-api';

import {
  submittalLabel,
  engagementLabel,
  dispositionSetting,
  requiredSetting,
  blockingSetting,
} from './labels';

// CSP PA-3 — the Company → Policies overview (§5). Three lifecycle policy cards
// (Engagement · Client Submittal · Pre-Start), each showing the effective version, a
// concise requirement summary with backend provenance badges, and Configure / View
// effective / History affordances. All display is backend truth — the FE never
// recomputes the effective policy or infers a source (§6/§31).

export type PolicyDomain = 'engagement' | 'client-submittal' | 'pre-start';
export type PolicyMode = 'configure' | 'effective' | 'history';

interface OverviewRow {
  readonly label: string;
  readonly setting: string;
  readonly provenance: RequirementProvenance;
}

function submittalRows(v: ClientSubmittalEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.requirements.map((r) => ({
    label: submittalLabel(r.key),
    setting: dispositionSetting(r.effective.disposition),
    provenance: r.provenance,
  }));
}
function engagementRows(v: EngagementEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.requirements.map((r) => ({
    label: engagementLabel(r.channel),
    setting: requiredSetting(r.requirement.required),
    provenance: r.provenance,
  }));
}
function preStartRows(v: PreStartEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.definitions.map((d) => ({
    label: d.label,
    setting: blockingSetting(d.blocking),
    provenance: d.provenance,
  }));
}

interface DomainCardData {
  readonly domain: PolicyDomain;
  readonly title: string;
  readonly description: string;
  readonly version: string | null;
  readonly overrides: number;
  readonly meta: string | null;
  readonly rows: readonly OverviewRow[];
  readonly summary: string;
  readonly loaded: boolean;
}

function summarize(rows: readonly OverviewRow[], overridable: number, floors: number): string {
  const required = rows.filter((r) => r.setting === 'Required' || r.setting === 'Blocking').length;
  const parts = [`${required} required`];
  if (overridable > 0) parts.push(`${overridable} overridable at runtime`);
  if (floors > 0) parts.push(`${floors} tenant floor`);
  return parts.join(' · ');
}

function overrideCount(rows: readonly OverviewRow[]): number {
  return rows.filter((r) => r.provenance.client_override || r.provenance.client_added).length;
}

// §6 — the compact source chip used in the overview rows (short labels, matching the
// prototype: Tenant / Override / Added). The full-text badge lives in PolicySourceBadge.
function ShortSource({ provenance }: { provenance: RequirementProvenance }): JSX.Element {
  if (provenance.client_added) return <span className="rc-src rc-src--added">Added</span>;
  if (provenance.client_override) return <span className="rc-src rc-src--override">Override</span>;
  return <span className="rc-src rc-src--tenant">Tenant</span>;
}

function LockIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label="Tenant floor" className="rc-lock">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
function metaLine(versions: readonly { version: string; published_at?: string | null; published_by?: string | null }[]): string | null {
  const v = versions[0];
  if (v === undefined) return null;
  const d = v.published_at === null || v.published_at === undefined ? null : new Date(v.published_at);
  const date = d !== null && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : null;
  return `Version ${v.version}${date !== null ? ` · Published ${date}` : ''}${v.published_by ? ` · ${v.published_by}` : ''}`;
}

export function CompanyPoliciesOverview({
  companyId,
  companyName,
  canConfigure,
  onOpen,
}: {
  companyId: string;
  companyName?: string;
  canConfigure?: Partial<Record<PolicyDomain, boolean>>;
  onOpen?: (domain: PolicyDomain, mode: PolicyMode) => void;
}): JSX.Element {
  const [cards, setCards] = useState<DomainCardData[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [sub, eng, pre, subH, engH, preH] = await Promise.allSettled([
        getClientSubmittalEffective(companyId),
        getEngagementEffective(companyId),
        getPreStartEffective(companyId),
        getClientSubmittalHistory('CLIENT', companyId),
        getEngagementHistory('CLIENT', companyId),
        getPreStartHistory('CLIENT', companyId),
      ]);
      if (!live) return;
      const subView = sub.status === 'fulfilled' ? sub.value.effective : null;
      const engView = eng.status === 'fulfilled' ? eng.value.effective : null;
      const preView = pre.status === 'fulfilled' ? pre.value.effective : null;
      const vers = (h: PromiseSettledResult<{ versions: readonly { version: string; published_at?: string | null; published_by?: string | null }[] }>) =>
        h.status === 'fulfilled' ? h.value.versions : [];
      const subRows = submittalRows(subView);
      const engRows = engagementRows(engView);
      const preRows = preStartRows(preView);
      setCards([
        {
          domain: 'engagement',
          title: 'Engagement Policy',
          description: 'Communication evidence required before client submittal.',
          version: engView?.composite_version ?? null,
          overrides: overrideCount(engRows),
          meta: metaLine(vers(engH)),
          rows: engRows,
          summary: summarize(engRows, 0, 0),
          loaded: eng.status === 'fulfilled',
        },
        {
          domain: 'client-submittal',
          title: 'Client Submittal Policy',
          description: 'What must be satisfied before talent is submitted to this client.',
          version: subView?.composite_version ?? null,
          overrides: overrideCount(subRows),
          meta: metaLine(vers(subH)),
          rows: subRows,
          summary: summarize(
            subRows,
            (subView?.requirements ?? []).filter((r) => r.effective.override_class === 'OVERRIDABLE').length,
            (subView?.requirements ?? []).filter((r) => r.provenance.tenant_floor).length,
          ),
          loaded: sub.status === 'fulfilled',
        },
        {
          domain: 'pre-start',
          title: 'Pre-Start Policy',
          description: 'What must be complete before a placement can start.',
          version: preView?.version ?? null,
          overrides: overrideCount(preRows),
          meta: metaLine(vers(preH)),
          rows: preRows,
          summary: summarize(
            preRows,
            0,
            (preView?.definitions ?? []).filter((d) => d.provenance.tenant_floor).length,
          ),
          loaded: pre.status === 'fulfilled',
        },
      ]);
      if (sub.status === 'rejected' && eng.status === 'rejected' && pre.status === 'rejected') {
        setError('Policies could not be loaded.');
      }
    })();
    return () => {
      live = false;
    };
  }, [companyId]);

  const clientLabel = companyName === undefined ? 'Client policy' : `Client policy · ${companyName}`;
  return (
    <div className="rc-policies">
      <div className="rc-policies__head">
        <div>
          <h3 className="rc-section-h">Policies</h3>
          <p className="rc-muted-line">Configure lifecycle requirements for working with this client.</p>
        </div>
        {/* §6 — the provenance legend; the badges themselves are backend truth. */}
        <div className="rc-policies__legend">
          <span className="rc-muted-line">Source:</span>
          <StatusPill tone="neutral">Inherited from tenant</StatusPill>
          <StatusPill tone="info">Client override</StatusPill>
          <StatusPill tone="warn">Client-added</StatusPill>
        </div>
      </div>
      {/* §5 — the TENANT → CLIENT → REQUISITION layering, in business language. */}
      <div className="rc-tier-strip">
        <div className="rc-tier">
          <span className="rc-tier__n">1</span>
          <span><b>Tenant defaults</b><span className="rc-muted-line">Baseline requirements for every client</span></span>
        </div>
        <div className="rc-tier rc-tier--active">
          <span className="rc-tier__n rc-tier__n--active">2</span>
          <span><b>{clientLabel}</b><span className="rc-muted-line">Adds or overrides where tenant policy permits</span></span>
        </div>
        <div className="rc-tier">
          <span className="rc-tier__n">3</span>
          <span><b>Requisition requirements</b><span className="rc-muted-line">Can add more; cannot weaken locked requirements</span></span>
        </div>
      </div>
      {error !== null ? <p className="rc-muted-line">{error}</p> : null}
      <div className="rc-policy-cards">
        {cards.map((c) => (
          <Card key={c.domain}>
            <div className="rc-policy-card__head">
              <h4 className="rc-policy-card__title">{c.title}</h4>
              <p className="rc-muted-line">{c.description}</p>
              <div className="rc-policy-card__meta">
                {c.overrides > 0 ? (
                  <StatusPill tone="info">{c.overrides} client override{c.overrides === 1 ? '' : 's'}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Tenant defaults only</StatusPill>
                )}
                {c.meta !== null ? <span className="rc-muted-line">{c.meta}</span> : null}
              </div>
            </div>
            <ul className="rc-policy-reqs">
              {c.rows.map((r) => (
                <li key={r.label} className="rc-policy-req">
                  <span className="rc-policy-req__label">
                    {r.label}
                    {r.provenance.tenant_floor ? <LockIcon /> : null}
                  </span>
                  <ShortSource provenance={r.provenance} />
                  <span
                    className={`rc-policy-req__setting${
                      r.setting === 'Required' || r.setting === 'Blocking' ? '' : ' rc-policy-req__setting--muted'
                    }`}
                  >
                    {r.setting}
                  </span>
                </li>
              ))}
              {c.loaded && c.rows.length === 0 ? (
                <li className="rc-muted-line">No effective requirements — inherits tenant defaults.</li>
              ) : null}
            </ul>
            <p className="rc-footnote">{c.summary}</p>
            <div className="rc-policy-card__actions">
              {canConfigure?.[c.domain] ? (
                <Button size="sm" onClick={() => onOpen?.(c.domain, 'configure')}>
                  Configure policy
                </Button>
              ) : null}
              <Button unstyled className="rc-link-action" onClick={() => onOpen?.(c.domain, 'effective')}>
                View effective policy
              </Button>
              <Button unstyled className="rc-link-action rc-link-action--muted" onClick={() => onOpen?.(c.domain, 'history')}>
                History
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <p className="rc-footnote">
        Policies are authored here and enforced where the work happens — submittal checks on the
        requisition, engagement evidence on communication, and the Pre-Start checklist on the placement.
      </p>
    </div>
  );
}
