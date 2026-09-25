import { useEffect, useState } from 'react';

import { Card, StatusPill, Button } from '../../ui';
import {
  getClientSubmittalEffective,
  getEngagementEffective,
  getPreStartEffective,
  type ClientSubmittalEffectiveView,
  type EngagementEffectiveView,
  type PreStartEffectiveView,
  type RequirementProvenance,
} from '../policies-api';

import { PolicySourceBadge } from './PolicySourceBadge';

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

const SUBMITTAL_LABELS: Record<string, string> = {
  resume_selected: 'Résumé selected',
  engagement_satisfied: 'Engagement satisfied',
  work_authorization_present: 'Work authorization',
  bill_rate_present: 'Bill rate',
  rtr_present: 'Right to Represent',
};

function submittalRows(v: ClientSubmittalEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.requirements.map((r) => ({
    label: SUBMITTAL_LABELS[r.key] ?? r.key,
    setting: r.effective.disposition === 'REQUIRED' ? 'Required' : 'Not required',
    provenance: r.provenance,
  }));
}
function engagementRows(v: EngagementEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.requirements.map((r) => ({
    label: r.channel === 'voice' ? 'Voice engagement' : 'Email engagement',
    setting: r.requirement.required ? 'Required' : 'Not required',
    provenance: r.provenance,
  }));
}
function preStartRows(v: PreStartEffectiveView | null): OverviewRow[] {
  if (v === null) return [];
  return v.definitions.map((d) => ({
    label: d.label,
    setting: d.blocking ? 'Blocking' : 'Non-blocking',
    provenance: d.provenance,
  }));
}

interface DomainCardData {
  readonly domain: PolicyDomain;
  readonly title: string;
  readonly description: string;
  readonly version: string | null;
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

export function CompanyPoliciesOverview({
  companyId,
  canConfigure,
  onOpen,
}: {
  companyId: string;
  canConfigure?: Partial<Record<PolicyDomain, boolean>>;
  onOpen?: (domain: PolicyDomain, mode: PolicyMode) => void;
}): JSX.Element {
  const [cards, setCards] = useState<DomainCardData[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [sub, eng, pre] = await Promise.allSettled([
        getClientSubmittalEffective(companyId),
        getEngagementEffective(companyId),
        getPreStartEffective(companyId),
      ]);
      if (!live) return;
      const subView = sub.status === 'fulfilled' ? sub.value.effective : null;
      const engView = eng.status === 'fulfilled' ? eng.value.effective : null;
      const preView = pre.status === 'fulfilled' ? pre.value.effective : null;
      const subRows = submittalRows(subView);
      const engRows = engagementRows(engView);
      const preRows = preStartRows(preView);
      setCards([
        {
          domain: 'engagement',
          title: 'Engagement Policy',
          description: 'Communication evidence required before client submittal.',
          version: engView?.composite_version ?? null,
          rows: engRows,
          summary: summarize(engRows, 0, 0),
          loaded: eng.status === 'fulfilled',
        },
        {
          domain: 'client-submittal',
          title: 'Client Submittal Policy',
          description: 'What must be satisfied before talent is submitted to this client.',
          version: subView?.composite_version ?? null,
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

  return (
    <div className="rc-policies">
      <div className="rc-policies__head">
        <h3 className="rc-section-h">Policies</h3>
        <p className="rc-muted-line">
          Authored here and enforced where the work happens — submittal checks on the requisition,
          engagement evidence on communication, and the Pre-Start checklist on the placement.
        </p>
      </div>
      {error !== null ? <p className="rc-muted-line">{error}</p> : null}
      <div className="rc-policy-cards">
        {cards.map((c) => (
          <Card key={c.domain}>
            <div className="rc-policy-card__head">
              <h4 className="rc-policy-card__title">{c.title}</h4>
              <p className="rc-muted-line">{c.description}</p>
              <div className="rc-policy-card__meta">
                {c.version !== null ? (
                  <StatusPill tone="info">{c.version}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Tenant defaults only</StatusPill>
                )}
              </div>
            </div>
            <ul className="rc-policy-reqs">
              {c.rows.map((r) => (
                <li key={r.label} className="rc-policy-req">
                  <span className="rc-policy-req__label">{r.label}</span>
                  <PolicySourceBadge provenance={r.provenance} />
                  <span className="rc-policy-req__setting">{r.setting}</span>
                </li>
              ))}
              {c.loaded && c.rows.length === 0 ? (
                <li className="rc-muted-line">No effective requirements.</li>
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
              <Button unstyled className="rc-link-action" onClick={() => onOpen?.(c.domain, 'history')}>
                History
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
