import { useEffect, useState } from 'react';

import { Button } from '../../ui';
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
  readonly required: boolean;
  readonly provenance: RequirementProvenance;
}

function submittalRows(v: ClientSubmittalEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.requirements.map((r) => ({
    label: submittalLabel(r.key),
    setting: dispositionSetting(r.effective.disposition),
    required: r.effective.disposition === 'REQUIRED',
    provenance: r.provenance,
  }));
}
function engagementRows(v: EngagementEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.requirements.map((r) => ({
    label: engagementLabel(r.channel),
    setting: requiredSetting(r.requirement.required),
    required: r.requirement.required,
    provenance: r.provenance,
  }));
}
function preStartRows(v: PreStartEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.definitions.map((d) => ({
    label: d.label,
    setting: blockingSetting(d.blocking),
    required: true,
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
  const clientName = companyName ?? 'this client';
  return (
    <div className="rc-pol">
      <div className="rc-pol__head">
        <div className="rc-pol__headmain">
          <div className="rc-pol__title">Policies</div>
          <div className="rc-pol__subtitle">Configure lifecycle requirements for working with {clientName}.</div>
        </div>
        <span className="rc-pol__legend">
          <span className="rc-pol__legend-lbl">Source:</span>
          <span className="rc-pol-lgd rc-pol-lgd--tenant">Inherited from tenant</span>
          <span className="rc-pol-lgd rc-pol-lgd--override">Client override</span>
          <span className="rc-pol-lgd rc-pol-lgd--added">Client-added</span>
        </span>
      </div>

      <div className="rc-pol-tiers">
        {[
          { n: '1', t: 'Tenant defaults', d: 'Baseline requirements for every client', on: false },
          { n: '2', t: clientLabel, d: 'Adds or overrides where tenant policy permits', on: true },
          { n: '3', t: 'Requisition requirements', d: 'Can add more requirements; cannot weaken locked requirements', on: false },
        ].map((tier) => (
          <div key={tier.n} className={`rc-pol-tier${tier.on ? ' rc-pol-tier--on' : ''}`}>
            <span className={`rc-pol-tier__n${tier.on ? ' rc-pol-tier__n--on' : ''}`}>{tier.n}</span>
            <span className="rc-pol-tier__text">
              <span className="rc-pol-tier__t">{tier.t}</span>
              <span className="rc-pol-tier__d">{tier.d}</span>
            </span>
          </div>
        ))}
      </div>

      {error !== null ? <p className="rc-muted-line">{error}</p> : null}

      <div className="rc-pol-cards">
        {cards.map((c) => (
          <div key={c.domain} className="rc-pol-card">
            <div className="rc-pol-card__head">
              <div className="rc-pol-card__title">{c.title}</div>
              <div className="rc-pol-card__purpose">{c.description}</div>
              <div className="rc-pol-card__statusrow">
                <span className={`rc-pol-status rc-pol-status--${c.overrides > 0 ? 'client' : 'tenant'}`}>
                  <span className="rc-pol-status__dot" />
                  {c.overrides > 0 ? `Client overrides · ${c.overrides}` : 'Tenant defaults only'}
                </span>
              </div>
              {c.meta !== null ? <div className="rc-pol-card__meta">{c.meta}</div> : null}
            </div>
            <div className="rc-pol-card__body">
              {c.rows.map((r) => (
                <div key={r.label} className="rc-pol-row">
                  <span className="rc-pol-row__label">
                    {r.label}
                    {r.provenance.tenant_floor ? <LockIcon /> : null}
                  </span>
                  <ShortSource provenance={r.provenance} />
                  <span className={`rc-pol-row__val${r.required ? '' : ' rc-pol-row__val--muted'}`}>{r.setting}</span>
                </div>
              ))}
              {c.loaded && c.rows.length === 0 ? (
                <div className="rc-pol-row rc-pol-row--empty">No effective requirements — inherits tenant defaults.</div>
              ) : null}
              <div className="rc-pol-card__counts">{c.summary}</div>
            </div>
            <div className="rc-pol-card__foot">
              {canConfigure?.[c.domain] ? (
                <Button unstyled className="rc-pol-btn" onClick={() => onOpen?.(c.domain, 'configure')}>
                  Configure policy
                </Button>
              ) : null}
              <Button unstyled className="rc-pol-link" onClick={() => onOpen?.(c.domain, 'effective')}>
                View effective policy
              </Button>
              <Button unstyled className="rc-pol-link rc-pol-link--muted" onClick={() => onOpen?.(c.domain, 'history')}>
                History
              </Button>
            </div>
          </div>
        ))}
      </div>

      <p className="rc-pol__foot">
        Policies are authored here and enforced where the work happens — submittal checks on the
        requisition, engagement evidence on communication, and the Pre-Start checklist on the placement.
      </p>
    </div>
  );
}
