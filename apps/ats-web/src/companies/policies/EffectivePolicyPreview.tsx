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

function Section({ title, rows }: { title: string; rows: readonly Row[] }): JSX.Element {
  return (
    <div className="rc-preview-section">
      <h4 className="rc-preview-section__h">{title}</h4>
      {rows.length === 0 ? (
        <p className="rc-muted-line">None.</p>
      ) : (
        <ul className="rc-policy-reqs">
          {rows.map((r) => (
            <li key={r.label} className="rc-policy-req">
              <span className="rc-policy-req__label">{r.label}</span>
              {'provenance' in r ? <PolicySourceBadge provenance={(r as EffRow).provenance} /> : <span />}
              <span className="rc-policy-req__setting">{r.setting}</span>
            </li>
          ))}
        </ul>
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
          <Section title="Tenant defaults" rows={data.tenant} />
          {data.client !== null ? <Section title="Client changes" rows={data.client} /> : null}
          <Section title="Effective policy" rows={data.effective} />
        </div>
      ) : null}
    </div>
  );
}
