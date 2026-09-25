import { useState } from 'react';

import {
  CompanyPoliciesOverview,
  type PolicyDomain,
  type PolicyMode,
} from './CompanyPoliciesOverview';
import { EffectivePolicyPreview } from './EffectivePolicyPreview';
import { PolicyHistoryPanel } from './PolicyHistoryPanel';
import { ClientSubmittalPolicyEditor } from './ClientSubmittalPolicyEditor';
import { EngagementPolicyEditor } from './EngagementPolicyEditor';
import { PreStartPolicyEditor } from './PreStartPolicyEditor';

// CSP PA-3 — the Company → Policies tab container. Owns the open sub-view: the overview,
// the read-only effective preview (§23), or the version history (§10). The domain
// editors (PA-4/5/6) replace the 'configure' route; until then Configure opens the
// read-only effective preview so the affordance is never a dead end.
export function CompanyPoliciesView({
  companyId,
  companyName,
  canConfigure,
}: {
  companyId: string;
  companyName?: string;
  canConfigure?: Partial<Record<PolicyDomain, boolean>>;
}): JSX.Element {
  const [open, setOpen] = useState<{ domain: PolicyDomain; mode: PolicyMode } | null>(null);
  const back = (): void => setOpen(null);

  if (open === null) {
    return (
      <CompanyPoliciesOverview
        companyId={companyId}
        companyName={companyName}
        canConfigure={canConfigure}
        onOpen={(domain, mode) => setOpen({ domain, mode })}
      />
    );
  }
  if (open.mode === 'history') {
    return <PolicyHistoryPanel domain={open.domain} companyId={companyId} onBack={back} />;
  }
  if (open.mode === 'configure' && open.domain === 'client-submittal') {
    return (
      <ClientSubmittalPolicyEditor
        companyId={companyId}
        companyName={companyName}
        onBack={back}
        onPreview={() => setOpen({ domain: 'client-submittal', mode: 'effective' })}
      />
    );
  }
  if (open.mode === 'configure' && open.domain === 'engagement') {
    return (
      <EngagementPolicyEditor
        companyId={companyId}
        companyName={companyName}
        onBack={back}
        onPreview={() => setOpen({ domain: 'engagement', mode: 'effective' })}
      />
    );
  }
  if (open.mode === 'configure' && open.domain === 'pre-start') {
    return (
      <PreStartPolicyEditor
        companyId={companyId}
        companyName={companyName}
        onBack={back}
        onPreview={() => setOpen({ domain: 'pre-start', mode: 'effective' })}
      />
    );
  }
  return <EffectivePolicyPreview domain={open.domain} companyId={companyId} onBack={back} />;
}
