import { SettingsSection } from '../components';

import { RolesMatrixView } from './RolesMatrixView';

// Settings Rebuild Directive 5 — Roles & permissions section (People & access
// group). Replaces the Directive-1 Roles ReservedSeam with the real, read-only
// matrix. READ-ONLY by design (D5/S4 safety) — no edit/assign/revoke here.
export function RolesSection() {
  return (
    <SettingsSection
      title="Roles & permissions"
      description="Every role is a named bundle of scopes. Pick a role to see exactly what it can do — the same model the server enforces. Read-only."
    >
      <RolesMatrixView />
    </SettingsSection>
  );
}
