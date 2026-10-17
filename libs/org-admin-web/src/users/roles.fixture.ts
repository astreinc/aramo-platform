import type { TenantRoleCatalogEntry } from './types';

// Settings Rebuild D5 — test fixture for the assignable roles. In production
// these come from the roles-catalog GET (the seed/DB single source); tests
// inject this fixed set so they don't depend on the network. Mirrors the 13
// tenant-tier roles, incl. the S4 gate on auditor_with_financials.
export const ROLE_FIXTURE: readonly TenantRoleCatalogEntry[] = Object.freeze([
  { key: 'tenant_owner', label: 'Tenant Owner', description: 'Full tenant authority.' },
  { key: 'tenant_admin', label: 'Tenant Admin', description: 'Tenant administration.' },
  { key: 'delivery_manager', label: 'Delivery Manager', description: 'Manages delivery teams.' },
  { key: 'account_manager', label: 'Account Manager', description: 'Owns client accounts.' },
  { key: 'recruiting_manager', label: 'Recruiting Manager', description: 'Leads a recruiting team.' },
  { key: 'lead_recruiter', label: 'Lead Recruiter', description: 'Senior recruiter.' },
  { key: 'sourcer', label: 'Sourcer', description: 'Sources talent.' },
  { key: 'recruiter', label: 'Recruiter', description: 'Standard recruiter.' },
  { key: 'finance', label: 'Finance', description: 'Sees bill markup.' },
  { key: 'auditor', label: 'Auditor', description: 'Read-only audit access.' },
  { key: 'back_office', label: 'Back Office', description: 'Operations tasks.' },
  { key: 'candidate', label: 'Candidate', description: 'Portal-side persona.' },
  {
    key: 'auditor_with_financials',
    label: 'Auditor with Financials',
    description: 'Audit access including see-all compensation.',
    helper: 'Requires "Financial-auditor grant" enabled in Settings.',
    requiresSetting: {
      key: 'audit.financials_enabled',
      disabledMessage:
        'Enable "Financial-auditor grant" in Settings before assigning this role.',
    },
  },
]);
