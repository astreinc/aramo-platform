import type { ActorType, EventType } from './identity-audit.repository.js';

// Settings Rebuild Directive 2 — the public read shape of an audit event.
//
// The audit log records EVENTS (who did what, when) — never any quality
// judgment or ordering of a person (R10-clean by construction). The `detail`
// is a HUMAN-READABLE, REDACTED one-line summary derived from a per-event-type
// whitelist of the payload — NEVER the raw payload dumped to screen, and never
// a secret/token/financial value the viewer's scopes don't permit (§D).

export interface AuditActorView {
  /** Null for pre-actor/system events. */
  readonly id: string | null;
  readonly type: ActorType;
  /** Resolved display (user display_name/email, or 'System'/'Service account'). */
  readonly display: string;
}

export interface AuditEventView {
  readonly id: string;
  readonly event_type: EventType;
  /** Coarse grouping for the FE category pill. */
  readonly category: AuditCategory;
  readonly actor: AuditActorView;
  /** The subject the event concerns (a user/team/tenant/etc. id). */
  readonly subject_id: string;
  /** Human-readable, redacted one-line summary of the event. */
  readonly detail: string;
  /** ISO-8601 timestamp. */
  readonly created_at: string;
}

export type AuditCategory =
  | 'setting'
  | 'access'
  | 'user'
  | 'org'
  | 'session'
  | 'system'
  // ORG-UX-1 (Directive v1.0 LOCKED §8.10) — the Org Audit "Domain" and "Templates" areas.
  | 'domain'
  | 'template';

export function categoryOf(eventType: EventType): AuditCategory {
  if (
    eventType.startsWith('identity.tenant_setting.') ||
    eventType === 'identity.tenant_profile.updated'
  ) {
    return 'setting';
  }
  if (eventType.startsWith('identity.session.')) return 'session';
  // ORG-UX-1 §8.10 — domain verification + Domain-Enforcement P3 claim / exception /
  // delegation events, and Org template governance events, get their own areas.
  if (eventType.startsWith('identity.domain.')) return 'domain';
  if (eventType.startsWith('identity.document_template.')) return 'template';
  if (
    eventType.startsWith('identity.role.') ||
    eventType.startsWith('identity.scope.') ||
    eventType === 'identity.tenant_user.role_assigned' ||
    eventType === 'identity.tenant_user.role_removed' ||
    // ROLES-1 PR-2 — the role-model reconciliation grants/removals.
    eventType === 'ROLES1_RECONCILE_GRANT' ||
    eventType === 'ROLES1_RECONCILE_REVOKE'
  ) {
    return 'access';
  }
  if (
    eventType.startsWith('identity.team.') ||
    eventType.startsWith('identity.management_edge.') ||
    eventType.startsWith('identity.user_client_assignment.') ||
    // Settings Rebuild D4 — sites/branches are org STRUCTURE.
    eventType.startsWith('identity.site.')
  ) {
    return 'org';
  }
  if (
    eventType === 'identity.tenant.created' ||
    eventType === 'identity.service_account.created'
  ) {
    return 'system';
  }
  // user/membership/invitation/external_identity/tenant_user.disabled
  return 'user';
}

// ── Redaction posture (§D) ──
//
// Settings keys whose VALUES are S4-/compensation-gated: the audit log records
// THAT they changed, but the before/after values are shown only to a viewer
// whose scopes permit the underlying data. `audit:read` holders (tenant_admin/
// tenant_owner) generally hold these, so this rarely elides — but the posture
// is enforced, not assumed.
const FINANCIAL_SETTING_KEYS = new Set<string>([
  'compensation.display_default',
  'audit.financials_enabled',
]);
const FINANCIAL_VIEW_SCOPE = 'compensation:view:bill';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Builds the readable, redacted `detail`. `payload` is the raw event_payload;
// `viewerScopes` gates financial values. Only whitelisted fields per event_type
// are ever surfaced — an unknown/future field is never echoed.
export function summarizeDetail(
  eventType: EventType,
  payload: Record<string, unknown>,
  viewerScopes: readonly string[],
): string {
  switch (eventType) {
    case 'identity.tenant_setting.updated': {
      const key = str(payload['key']) ?? 'a setting';
      const gated =
        FINANCIAL_SETTING_KEYS.has(key) && !viewerScopes.includes(FINANCIAL_VIEW_SCOPE);
      if (gated) return `Updated ${key} (values hidden — restricted)`;
      const value = renderScalar(payload['value']);
      const prev = renderScalar(payload['previous_value']);
      if (value === null) return `Updated ${key}`;
      return prev === null
        ? `Set ${key} to ${value}`
        : `Changed ${key} from ${prev} to ${value}`;
    }
    case 'identity.tenant_user.role_assigned':
    case 'identity.tenant_user.role_removed': {
      const roles = renderStringList(payload['role_keys']);
      const verb = eventType.endsWith('assigned') ? 'Assigned' : 'Removed';
      return roles === null
        ? `${verb} roles`
        : `${verb} role(s): ${roles}`;
    }
    case 'identity.tenant_user.disabled': {
      const reason = str(payload['reason']);
      return reason === null ? 'Disabled tenant access' : `Disabled tenant access — ${reason}`;
    }
    case 'identity.tenant_profile.updated': {
      const fields = renderStringList(payload['changed_fields']);
      return fields === null
        ? 'Updated the tenant profile'
        : `Updated tenant profile: ${fields}`;
    }
    case 'identity.invitation.created':
      return 'Invited a user to the tenant';
    // ORG-UX-1 §8.3 (G9).
    case 'identity.tenant_user.invitation_resent':
      return str(payload['sent']) === 'confirmation' ? 'Resent the sign-in reminder' : 'Resent an invitation';
    case 'identity.tenant_user.invitation_revoked':
      return 'Revoked an invitation';
    case 'identity.tenant_user.email_changed':
      return 'Changed an invited user\'s email and resent the invitation';
    case 'identity.invitation.accepted':
      return 'Accepted a tenant invitation';
    case 'identity.invitation.rejected_cross_tenant':
      return 'Refused an invitation — the email is already registered to another tenant';
    case 'identity.user.created':
      return 'Created a user';
    case 'identity.membership.created':
      return 'Created a tenant membership';
    case 'identity.external_identity.linked':
      return 'Linked an external identity';
    case 'identity.role.created':
      return 'Created a role';
    case 'identity.scope.created':
      return 'Created a scope';
    case 'identity.service_account.created':
      return 'Created a service account';
    case 'identity.tenant.created':
      return 'Created the tenant';
    case 'identity.session.issued':
      return 'Signed in';
    case 'identity.session.refreshed':
      return 'Refreshed a session';
    case 'identity.session.revoked':
      return 'Signed out / session revoked';
    case 'identity.session.reuse_detected':
      return 'Session token reuse detected';
    case 'identity.management_edge.set':
      return 'Set a reporting relationship';
    case 'identity.management_edge.cleared':
      return 'Cleared a reporting relationship';
    case 'identity.team.created':
      return 'Created a team';
    case 'identity.team.membership.added':
      return 'Added a team member';
    case 'identity.team.membership.removed':
      return 'Removed a team member';
    case 'identity.team.client_ownership.added':
      return 'Assigned a client to a team';
    case 'identity.team.client_ownership.removed':
      return 'Unassigned a client from a team';
    case 'identity.user_client_assignment.created':
      return 'Assigned a user to a client';
    case 'identity.user_client_assignment.removed':
      return 'Unassigned a user from a client';
    case 'identity.site.created':
      return 'Created a branch (site)';
    case 'identity.site.updated': {
      const fields = renderStringList(payload['changed_fields']);
      return fields === null
        ? 'Updated a branch (site)'
        : `Updated a branch (site): ${fields}`;
    }
    case 'identity.site.deactivated':
      return 'Deactivated a branch (site)';
    case 'ROLES1_RECONCILE_GRANT':
    case 'ROLES1_RECONCILE_REVOKE': {
      const role = str(payload['role_key']);
      const verb = eventType === 'ROLES1_RECONCILE_GRANT' ? 'Granted' : 'Removed';
      return role === null
        ? `Role model update: ${verb.toLowerCase()} a role`
        : `Role model update: ${verb.toLowerCase()} ${role}`;
    }
    case 'identity.document_template.draft_discarded': {
      const n = payload['version_number'];
      return typeof n === 'number' ? `Discarded a document template draft (v${n})` : 'Discarded a document template draft';
    }
    case 'identity.document_template.withdrawal_published':
      return 'Published the withdrawal of an Aramo default template';
    case 'identity.document_template.withdrawal_cancelled':
      return 'Cancelled the withdrawal of an Aramo default template';
    // Domain-Enforcement P3 — the organization's claim on its email domain.
    case 'identity.domain.claim.provisional':
      return 'Reserved the organization email domain';
    case 'identity.domain.claim.authoritative':
      return 'Confirmed the organization email domain';
    case 'identity.domain.claim.lapsed':
      return 'The organization email domain reservation lapsed';
    case 'identity.domain.claim.released':
      return 'Released the organization email domain';
    case 'identity.domain.exception.granted':
      return 'Granted a shared email domain exception';
    case 'identity.domain.exception.revoked':
      return 'Revoked a shared email domain exception';
    // Sign Personal (Free) Launch v1.1 — the Personal account's signup and risk state.
    case 'identity.personal.signup.provisioned':
      return 'Created the personal account';
    case 'identity.personal.signup.lapsed':
      return 'The unclaimed personal account lapsed';
    case 'identity.personal.risk.review_flagged':
      return 'Held the personal account for review';
    case 'identity.personal.risk.step_up_required':
      return 'Asked for phone verification';
    case 'identity.personal.risk.phone_verified':
      return 'Verified the phone number';
    case 'identity.personal.risk.restricted':
      return 'Restricted sending';
    case 'identity.personal.risk.review_cleared':
      return 'Cleared the review';
    case 'identity.personal.risk.reinstated':
      return 'Reinstated sending';
    case 'identity.personal.risk.closed':
      return 'Closed the personal account';
    case 'identity.personal.risk.send_location_signal':
      return 'Recorded a send from outside the supported countries or an unknown location';
    case 'identity.personal.invite.issued':
      return 'Issued a personal pilot invite';
    case 'identity.personal.signup.attempts_purged':
      return 'Deleted expired and refused personal signup attempts';
    // ORG-UX-1 §8.10 — P3 verification delegation (previously unsummarized).
    case 'identity.domain.verification.delegation.issued':
      return 'Asked someone else to verify the email domain';
    case 'identity.domain.verification.delegation.used':
      return 'The domain verification link was used';
    case 'identity.domain.verification.delegation.revoked':
      return 'Revoked a domain verification link';
    // ORG-UX-1 §5.4 — Org template governance.
    case 'identity.document_template.adopted':
      return 'Adopted an Aramo starting point as a document template draft';
    case 'identity.document_template.created':
      return 'Created a document template';
    case 'identity.document_template.version_activated': {
      const n = payload['version_number'];
      return typeof n === 'number' ? `Approved a document template (v${n})` : 'Approved a document template';
    }
    case 'identity.document_template.selection_set':
      return 'Chose the active document template';
    case 'identity.document_template.selection_cleared':
      return 'Cleared the active document template choice';
    default:
      // Exhaustive over EVENT_TYPES; a future type lands here until summarized.
      return humanizeEventType(eventType);
  }
}

function renderScalar(v: unknown): string | null {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function renderStringList(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const parts = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

function humanizeEventType(eventType: string): string {
  return eventType.replace(/^identity\./, '').replace(/[._]/g, ' ');
}
