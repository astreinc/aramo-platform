import { SettingsSection } from '../components';

import { AuditLogView } from './AuditLogView';

// Settings Rebuild Directive 2 — Audit log section (Account group). Replaces
// the Directive-1 ReservedSeam with the real, live read surface.
export function AuditSection() {
  return (
    <SettingsSection
      title="Audit log"
      description="Every administrative and security event — who did what, and when. Filter by event, actor, date or subject; the trail is read-only and tenant-scoped."
    >
      <AuditLogView />
    </SettingsSection>
  );
}
