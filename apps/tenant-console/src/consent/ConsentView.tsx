// Consent view container — PR-9 §4.1 / §4.2.
//
// Route component for /consent/:talentId inside the authenticated Shell.
// Hosts the three consent visibility panels for a single talent_id read
// from the route param. PR-9 builds no talent search/selection UI;
// reachability is by direct URL (later M1+ work adds discovery).

import { useParams } from 'react-router-dom';

import { ConsentDecisionLogPanel } from './ConsentDecisionLogPanel';
import { ConsentHistoryPanel } from './ConsentHistoryPanel';
import { ConsentStatePanel } from './ConsentStatePanel';

export function ConsentView() {
  const { talentId } = useParams<{ talentId: string }>();

  if (!talentId) {
    return (
      <section className="aramo-consent-view" data-testid="consent-view">
        <h1>Consent visibility</h1>
        <p>A talent identifier is required.</p>
      </section>
    );
  }

  return (
    <section className="aramo-consent-view" data-testid="consent-view">
      <h1>Consent visibility for talent {talentId}</h1>
      <ConsentStatePanel talentId={talentId} />
      <ConsentHistoryPanel talentId={talentId} />
      <ConsentDecisionLogPanel talentId={talentId} />
    </section>
  );
}
