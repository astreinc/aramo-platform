import { IconBuilding, orgEntryHref } from '@aramo/fe-foundation';
import { RolesMatrixView, type RoleCatalogView } from '@aramo/org-admin-web';

import { Card } from '../../ui';
import { SettingsSection } from '../components';

// ATS roles & permissions (accepted Settings & navigation change log A4) — a
// READ-ONLY REFERENCE of what each ATS role can do. NO assignment or edit
// control exists here: giving a role to a person, changing it or removing access
// happens in Organization administration (Users & product access), the single
// authority for role assignment (PATCH /v1/tenant/users/:id/roles).
//
// The list shows the ATS roles (ats_admin and the staffing roles): the Sign
// (`sign_*`) roles and the organization roles (tenant_owner, tenant_admin —
// ROLES-1 PR-2, administered in Organization administration) belong to other
// surfaces (display filter only).
const ORG_ROLE_KEYS: readonly string[] = ['tenant_owner', 'tenant_admin'];
export function isAtsRole(role: RoleCatalogView): boolean {
  return !role.key.startsWith('sign_') && !ORG_ROLE_KEYS.includes(role.key);
}

function hereForReturn(): string {
  return typeof window === 'undefined' ? '/ats/admin/settings/roles' : `${window.location.pathname}${window.location.search}`;
}

export function AtsRolesSection() {
  return (
    <SettingsSection
      title="ATS roles & permissions"
      description="Every role is a named bundle of scopes. Pick a role to see exactly what it can do — the same model the server enforces. Read-only."
      actions={<span className="set-readonly-pill">Read-only reference</span>}
    >
      <Card flush>
        <div className="set-org-row">
          <span className="set-org-row__icon" aria-hidden="true">
            <IconBuilding />
          </span>
          <span className="set-org-row__text">
            <span className="set-org-row__t">Reference only — what each ATS role can do</span>
            <span className="set-org-row__s">
              Giving a role to a person, changing it or removing access happens in Organization administration.
            </span>
          </span>
          <a
            className="set-org-row__btn"
            href={orgEntryHref('roles', { app: 'ats', path: hereForReturn() })}
            data-testid="ats-roles-manage-access"
          >
            Manage user access <span className="set-navbtn__badge set-navbtn__badge--app">App Home</span>
          </a>
        </div>
      </Card>
      <RolesMatrixView roleFilter={isAtsRole} />
    </SettingsSection>
  );
}
