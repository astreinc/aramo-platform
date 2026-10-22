import type { PillTone } from '@aramo/fe-foundation';

import type { AuditCategory } from './types';

// Settings Rebuild Directive 2 — the closed event-type set the filter dropdown
// enumerates, with human labels, plus category → pill-tone mapping. Mirrors
// libs/identity EVENT_TYPES.

export interface EventTypeOption {
  readonly value: string;
  readonly label: string;
}

// Grouped for the dropdown; order mirrors the backend catalog grouping.
export const EVENT_TYPE_OPTIONS: readonly EventTypeOption[] = [
  { value: 'identity.user.created', label: 'User created' },
  { value: 'identity.tenant.created', label: 'Tenant created' },
  { value: 'identity.membership.created', label: 'Membership created' },
  { value: 'identity.role.created', label: 'Role created' },
  { value: 'identity.scope.created', label: 'Scope created' },
  { value: 'identity.service_account.created', label: 'Service account created' },
  { value: 'identity.external_identity.linked', label: 'External identity linked' },
  { value: 'identity.session.issued', label: 'Signed in' },
  { value: 'identity.session.refreshed', label: 'Session refreshed' },
  { value: 'identity.session.revoked', label: 'Signed out' },
  { value: 'identity.session.reuse_detected', label: 'Token reuse detected' },
  { value: 'identity.invitation.created', label: 'Invitation sent' },
  { value: 'identity.invitation.accepted', label: 'Invitation accepted' },
  { value: 'identity.management_edge.set', label: 'Reporting line set' },
  { value: 'identity.management_edge.cleared', label: 'Reporting line cleared' },
  { value: 'identity.team.created', label: 'Team created' },
  { value: 'identity.team.membership.added', label: 'Team member added' },
  { value: 'identity.team.membership.removed', label: 'Team member removed' },
  { value: 'identity.team.client_ownership.added', label: 'Team client assigned' },
  { value: 'identity.team.client_ownership.removed', label: 'Team client unassigned' },
  { value: 'identity.user_client_assignment.created', label: 'User assigned to client' },
  { value: 'identity.user_client_assignment.removed', label: 'User unassigned from client' },
  { value: 'identity.tenant_setting.updated', label: 'Setting updated' },
  { value: 'identity.tenant_user.disabled', label: 'User disabled' },
  { value: 'identity.tenant_user.role_assigned', label: 'Role assigned' },
  { value: 'identity.tenant_user.role_removed', label: 'Role removed' },
  { value: 'identity.tenant_user.enabled', label: 'User enabled' },
  // ORG-UX-1 §8.3 (G9) — invitation lifecycle.
  { value: 'identity.tenant_user.invitation_resent', label: 'Invitation resent' },
  { value: 'identity.tenant_user.invitation_revoked', label: 'Invitation revoked' },
  { value: 'identity.tenant_user.email_changed', label: 'Invited email changed' },
  { value: 'identity.tenant_profile.updated', label: 'Organization profile updated' },
  { value: 'identity.site.created', label: 'Site created' },
  { value: 'identity.site.updated', label: 'Site updated' },
  { value: 'identity.site.deactivated', label: 'Site deactivated' },
  // Domain verification (P2b) + Domain-Enforcement P3 — ORG-UX-1 §8.10 (G12, G17).
  { value: 'identity.domain.verification.requested', label: 'Domain TXT record issued' },
  { value: 'identity.domain.verified', label: 'Domain verified' },
  { value: 'identity.domain.claim.provisional', label: 'Domain reserved' },
  { value: 'identity.domain.claim.authoritative', label: 'Domain ownership confirmed' },
  { value: 'identity.domain.claim.lapsed', label: 'Domain reservation lapsed' },
  { value: 'identity.domain.claim.released', label: 'Domain released' },
  { value: 'identity.domain.exception.granted', label: 'Shared domain exception granted' },
  { value: 'identity.domain.exception.revoked', label: 'Shared domain exception revoked' },
  { value: 'identity.domain.verification.delegation.issued', label: 'Domain verification link sent' },
  { value: 'identity.domain.verification.delegation.used', label: 'Domain verification link used' },
  { value: 'identity.domain.verification.delegation.revoked', label: 'Domain verification link revoked' },
  // ORG-UX-1 §5.4 — Org template governance.
  { value: 'identity.document_template.adopted', label: 'Template adopted' },
  { value: 'identity.document_template.created', label: 'Template created' },
  { value: 'identity.document_template.version_activated', label: 'Template approved' },
  { value: 'identity.document_template.selection_set', label: 'Active template chosen' },
  { value: 'identity.document_template.selection_cleared', label: 'Active template choice cleared' },
];

const LABEL_BY_VALUE = new Map(EVENT_TYPE_OPTIONS.map((o) => [o.value, o.label]));

export function eventTypeLabel(value: string): string {
  return LABEL_BY_VALUE.get(value) ?? value.replace(/^identity\./, '').replace(/[._]/g, ' ');
}

// Category → StatusPill tone (the ui PillTone union).
export const CATEGORY_TONE: Record<AuditCategory, PillTone> = {
  setting: 'info',
  access: 'warn',
  user: 'brand',
  org: 'neutral',
  session: 'neutral',
  system: 'neutral',
  domain: 'info',
  template: 'brand',
};

export const CATEGORY_LABEL: Record<AuditCategory, string> = {
  setting: 'Setting',
  access: 'Access',
  user: 'User',
  org: 'Org',
  session: 'Session',
  system: 'System',
  domain: 'Domain',
  template: 'Templates',
};
