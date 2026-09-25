import { StatusPill } from '../../ui';
import type { RequirementProvenance } from '../policies-api';

// CSP PA-3 — the source/provenance badges (§6). Every badge is BACKEND TRUTH read off
// `provenance`; the FE never infers a source by comparing layers itself. A requirement
// carries its origin badge (Inherited / Client override / Client-added) and, when the
// TENANT layer floors it, an additional non-relaxable "Tenant floor" badge.
export function PolicySourceBadge({ provenance }: { provenance: RequirementProvenance }): JSX.Element {
  return (
    <span className="rc-badges">
      {provenance.client_added ? (
        <StatusPill tone="warn">Client-added</StatusPill>
      ) : provenance.client_override ? (
        <StatusPill tone="info">Client override</StatusPill>
      ) : (
        <StatusPill tone="neutral">Inherited from tenant</StatusPill>
      )}
      {provenance.tenant_floor ? <StatusPill tone="brand">Tenant floor</StatusPill> : null}
    </span>
  );
}
