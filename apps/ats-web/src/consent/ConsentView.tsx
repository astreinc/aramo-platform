// Consent view container — PR-9 §4.1 / §4.2 (ported to ats-web /admin,
// FE Consolidation Directive 2; restyled to Confident Blue).
//
// Route component for /admin/consent/:talentId inside the admin-gated subtree.
// Hosts the three consent visibility panels for a single talent_id read from
// the route param. Reachability is by direct URL / the AdminSection lookup;
// PR-9 builds no talent search/selection UI (later M1+ work adds discovery).

import { useParams } from 'react-router-dom';

import { PageHeader } from '../ui';

import { ConsentDecisionLogPanel } from './ConsentDecisionLogPanel';
import { ConsentHistoryPanel } from './ConsentHistoryPanel';
import { ConsentStatePanel } from './ConsentStatePanel';

export function ConsentView() {
  const { talentId } = useParams<{ talentId: string }>();

  if (!talentId) {
    return (
      <section className="rc-stack" data-testid="consent-view">
        <PageHeader
          title="Consent visibility"
          description="A talent identifier is required."
        />
      </section>
    );
  }

  return (
    <section className="rc-stack" data-testid="consent-view">
      <PageHeader
        title="Consent visibility"
        description={`Talent ${talentId}`}
      />
      <ConsentStatePanel talentId={talentId} />
      <ConsentHistoryPanel talentId={talentId} />
      <ConsentDecisionLogPanel talentId={talentId} />
    </section>
  );
}
