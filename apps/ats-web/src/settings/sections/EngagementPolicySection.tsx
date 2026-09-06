import { hasScope, useSession } from '@aramo/fe-foundation';

import { SettingsSection } from '../components';
import { EngagementPolicyPanel } from '../../engagement/EngagementPolicyPanel';

// COMM-C3 — Settings → Recruiting → Engagement Policy. Provider-neutral policy
// authoring/publication (the enforcement boundary for Submit to Client). Reads
// engagement:policy:read; edit/publish controls self-gate on engagement:policy:write.
// Provider setup lives separately under Integrations → Communications.
export function EngagementPolicySection() {
  const sessionState = useSession();
  const session = sessionState.status === 'authenticated' ? sessionState.session : null;
  const canRead = session != null && hasScope(session, 'engagement:policy:read');
  const canWrite = session != null && hasScope(session, 'engagement:policy:write');

  return (
    <SettingsSection
      title="Engagement Policy"
      description="Define what engagement evidence recruiters must record before submitting Talent to a client. It is non-enforcing until you publish a policy. Communication providers are configured separately under Integrations."
    >
      <EngagementPolicyPanel canRead={canRead} canWrite={canWrite} />
    </SettingsSection>
  );
}
