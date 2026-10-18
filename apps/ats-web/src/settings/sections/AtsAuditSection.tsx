import { AuditLogView } from '@aramo/org-admin-web';

import { SettingsSection } from '../components';

// Audit log (accepted Settings & navigation change log A7 — ATS-owned). The read
// surface is the tenant audit trail (GET /v1/tenant/audit-events, audit:read),
// the same component Organization administration renders; product-scoped
// filtering of the trail is a backend gap recorded in the unified-UX report.
export function AtsAuditSection() {
  return (
    <SettingsSection
      title="Audit log"
      description="Every administrative and security event — who did what, and when. Filter by event, actor, date or subject; the trail is read-only and tenant-scoped."
    >
      <AuditLogView />
    </SettingsSection>
  );
}
