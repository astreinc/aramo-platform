import { useEffect, useState } from 'react';

import { Button } from '../../ui';
import {
  getClientSubmittalLayers,
  getEngagementLayers,
  getPreStartLayers,
  type RequirementProvenance,
} from '../policies-api';

import type { PolicyDomain } from './CompanyPoliciesOverview';
import { PolicySourceBadge } from './PolicySourceBadge';
import {
  submittalLabel,
  engagementLabel,
  dispositionSetting,
  requiredSetting,
  blockingSetting,
  DOMAIN_TITLES,
} from './labels';

// CSP PA-3 (§23) — the read-only effective preview: Tenant defaults → Client changes →
// Effective policy, consumed straight from the authoritative raw-layer + effective
// reads. The browser never recomputes the merge (§31); the effective rows carry backend
// provenance badges.

interface Row {
  readonly label: string;
  readonly setting: string;
}
interface EffRow extends Row {
  readonly provenance: RequirementProvenance;
}
interface PreviewData {
  readonly tenant: readonly Row[];
  readonly client: readonly Row[] | null;
  readonly effective: readonly EffRow[];
}

async function loadPreview(domain: PolicyDomain, companyId: string): Promise<PreviewData> {
  if (domain === 'client-submittal') {
    const { layers } = await getClientSubmittalLayers(companyId);
    return {
      tenant: layers.tenant.requirements.map((r) => ({ label: submittalLabel(r.key), setting: dispositionSetting(r.disposition) })),
      client: layers.client?.present
        ? layers.client.requirements.map((r) => ({ label: submittalLabel(r.key), setting: dispositionSetting(r.disposition) }))
        : null,
      effective: (layers.effective?.requirements ?? []).map((r) => ({
        label: submittalLabel(r.key),
        setting: dispositionSetting(r.effective.disposition),
        provenance: r.provenance,
      })),
    };
  }
  if (domain === 'engagement') {
    const { layers } = await getEngagementLayers(companyId);
    return {
      tenant: layers.tenant.requirements.map((r) => ({ label: engagementLabel(r.channel), setting: requiredSetting(r.required) })),
      client: layers.client?.present
        ? layers.client.requirements.map((r) => ({ label: engagementLabel(r.channel), setting: requiredSetting(r.required) }))
        : null,
      effective: (layers.effective?.requirements ?? []).map((r) => ({
        label: engagementLabel(r.channel),
        setting: requiredSetting(r.requirement.required),
        provenance: r.provenance,
      })),
    };
  }
  const { layers } = await getPreStartLayers(companyId);
  return {
    tenant: layers.tenant.definitions.map((d) => ({ label: d.label, setting: blockingSetting(d.blocking) })),
    client: layers.client?.present
      ? layers.client.definitions.map((d) => ({ label: d.label, setting: blockingSetting(d.blocking) }))
      : null,
    effective: (layers.effective?.definitions ?? []).map((d) => ({
      label: d.label,
      setting: blockingSetting(d.blocking),
      provenance: d.provenance,
    })),
  };
}

type ColTone = 'tenant' | 'client' | 'effective';

function markFor(tone: ColTone, r: Row): { glyph: string; cls: string } {
  const required = r.setting === 'Required' || r.setting === 'Blocking';
  if (tone === 'tenant') return required ? { glyph: '✓', cls: 'ok' } : { glyph: '✕', cls: 'muted' };
  if (tone === 'client') return { glyph: '+', cls: 'added' };
  const floored = 'provenance' in r && (r as EffRow).provenance.tenant_floor;
  return floored ? { glyph: '🔒', cls: 'ok' } : { glyph: '✓', cls: 'ok' };
}

function Column({ title, sub, tone, rows }: { title: string; sub: string; tone: ColTone; rows: readonly Row[] }): JSX.Element {
  return (
    <div className={`rc-preview-col rc-preview-col--${tone}`}>
      <div className="rc-preview-col__head">
        <span className="rc-preview-col__h">{title}</span>
        <span className="rc-muted-line">{sub}</span>
      </div>
      {rows.length === 0 ? (
        <p className="rc-muted-line">
          {tone === 'client' ? 'No changes — this client uses tenant defaults.' : 'Nothing required.'}
        </p>
      ) : (
        rows.map((r) => {
          const m = markFor(tone, r);
          return (
            <div key={r.label} className="rc-preview-item">
              <span className={`rc-preview-item__mark rc-preview-item__mark--${m.cls}`}>{m.glyph}</span>
              <span className="rc-preview-item__text">
                {r.label} — {r.setting}
              </span>
              {tone === 'effective' && 'provenance' in r ? <PolicySourceBadge provenance={(r as EffRow).provenance} /> : null}
            </div>
          );
        })
      )}
    </div>
  );
}

export function EffectivePolicyPreview({
  domain,
  companyId,
  onBack,
}: {
  domain: PolicyDomain;
  companyId: string;
  onBack: () => void;
}): JSX.Element {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadPreview(domain, companyId)
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setError('Effective policy could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [domain, companyId]);

  return (
    <div className="rc-policy-detail">
      <div className="rc-policy-detail__head">
        <Button unstyled className="rc-link-action" onClick={onBack}>
          ‹ Policies
        </Button>
        <h3 className="rc-section-h">{DOMAIN_TITLES[domain]} — effective policy</h3>
        <p className="rc-muted-line">
          Read-only. Effective policy = tenant defaults + this client’s changes.
        </p>
      </div>
      {error !== null ? <p className="rc-muted-line">{error}</p> : null}
      {data !== null ? (
        <div className="rc-preview">
          <Column title="Tenant default" sub="applies to every client" tone="tenant" rows={data.tenant} />
          <Column title="Client changes" sub="this client" tone="client" rows={data.client ?? []} />
          <Column title="Effective policy" sub="what is enforced" tone="effective" rows={data.effective} />
        </div>
      ) : null}
      <p className="rc-footnote">
        Requisitions for this client can add further requirements of their own; they cannot weaken
        tenant-floor requirements.
      </p>
    </div>
  );
}
