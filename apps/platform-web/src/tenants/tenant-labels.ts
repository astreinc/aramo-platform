import { tenantStatusPill, type PillSpec, type PlatformTone, type TimelineEvent } from '../components';
import type { PlatformAuditEvent } from '../platform-api';

import { reasonLabel } from './lifecycle-reasons';

// PLATFORM-UX-1 F-3/F-5 — human labels for the tenant enums and codes the
// console shows (handoff §5, §6.3): raw dotted event names and snake_case codes
// are never the label; the raw code is shown secondary, in mono.

/** The 9 tenant audit event types the backend records (libs/identity TenantService + PlatformInvitationService). */
export const TENANT_EVENT_LABEL: Readonly<Record<string, string>> = {
  'tenant.provisioned': 'Provisioned',
  'tenant.owner_invite.sent': 'Owner invite sent',
  'tenant.owner_invite.accepted': 'Owner invite accepted',
  'tenant.activated': 'Activated',
  'tenant.suspended': 'Suspended',
  'tenant.reactivated': 'Reactivated',
  'tenant.offboarding_started': 'Offboarding started',
  'tenant.closed': 'Closed',
  'tenant.lifecycle_transition_rejected': 'Transition rejected',
};

/** "tenant.owner_invite.sent" → "Owner invite sent"; an unknown type is sentence-cased, never shown raw. */
export function eventLabel(eventType: string): string {
  const known = TENANT_EVENT_LABEL[eventType];
  if (known !== undefined) return known;
  const tail = eventType.replace(/^tenant\./, '');
  return reasonLabel(tail);
}

export const REJECTED_EVENT = 'tenant.lifecycle_transition_rejected';

/**
 * The actor type label. The backend records `user` | `system` | `provider`; a
 * `user` actor is the platform operator, except on the owner's own invite
 * acceptance (the design's "Tenant owner").
 */
export function actorLabel(actorType: string, eventType?: string): string {
  if (actorType === 'system') return 'System';
  if (actorType === 'provider') return 'Sign-in provider';
  if (actorType === 'user') return eventType === 'tenant.owner_invite.accepted' ? 'Tenant owner' : 'Operator';
  return reasonLabel(actorType);
}

export function kindLabel(kind: string): string {
  if (kind === 'BUSINESS') return 'Business';
  if (kind === 'PERSONAL') return 'Personal';
  return reasonLabel(kind);
}

/** "microsoft" → "Microsoft"; null → the chooser. */
export function providerLabel(provider: string | null): string {
  if (provider === null || provider.trim() === '') return 'Chooser (no home provider)';
  const p = provider.trim().toLowerCase();
  if (p === 'microsoft') return 'Microsoft';
  if (p === 'google') return 'Google';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Capability keys → the design's names (CAPS). */
export const CAPABILITY_LABEL: Readonly<Record<string, string>> = {
  core: 'Core',
  ats: 'ATS',
  portal: 'Portal',
  sourcing: 'Sourcing',
  sign: 'Sign',
  esign: 'Sign',
  intelligence: 'Intelligence',
};

export function capabilityLabel(key: string): string {
  return CAPABILITY_LABEL[key] ?? reasonLabel(key);
}

interface AuditPayload {
  readonly before?: { readonly status?: unknown };
  readonly after?: { readonly status?: unknown };
  readonly reason?: unknown;
  readonly context?: { readonly source?: unknown };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The reason code and note recorded on an audit event (string or { code, text } shapes). */
export function auditReason(e: PlatformAuditEvent): { code: string | null; text: string | null } {
  const p = e.event_payload as AuditPayload;
  if (typeof p.reason === 'string') return { code: str(p.reason), text: null };
  const r = (p.reason ?? null) as { code?: unknown; text?: unknown } | null;
  let code = r === null ? null : str(r.code);
  // The owner's first sign-in activation records its source, not a code.
  if (code === null && e.event_type === 'tenant.activated') code = str(p.context?.source);
  return { code, text: r === null ? null : str(r.text) };
}

/** The from → to statuses recorded on a transition event, when both are present. */
export function auditTransition(e: PlatformAuditEvent): { from: string; to: string } | null {
  const p = e.event_payload as AuditPayload;
  const from = str(p.before?.status);
  const to = str(p.after?.status);
  return from !== null && to !== null ? { from, to } : null;
}

/** An audit row → a Timeline event (handoff §6.3): rejected = danger dot, else the target status tone. */
export function toTimelineEvent(e: PlatformAuditEvent, index: number): TimelineEvent {
  const ft = auditTransition(e);
  const reason = auditReason(e);
  const rejected = e.event_type === REJECTED_EVENT;
  // The dot takes the target status's tone whenever the event records one, even
  // without a from-status (the design's `e.to ? TONE[TS[e.to]]` — e.g. Provisioned).
  const toStatus = ft?.to ?? str((e.event_payload as AuditPayload).after?.status);
  const tone: PlatformTone | 'faint' = rejected ? 'danger' : toStatus !== null ? tenantStatusPill(toStatus).tone : 'faint';
  return {
    id: `${e.event_type}-${e.created_at}-${index}`,
    label: eventLabel(e.event_type),
    at: e.created_at,
    tone,
    from: ft ? tenantStatusPill(ft.from) : null,
    to: ft ? tenantStatusPill(ft.to) : null,
    reason: reason.code ? { label: reasonLabel(reason.code), code: reason.code } : null,
    actor: { label: actorLabel(e.actor_type, e.event_type), id: e.actor_type === 'system' ? null : e.actor_id },
    note: reason.text ?? undefined,
  };
}

/** Newest first (the API already orders it; re-sorted defensively). */
export function timelineFrom(events: readonly PlatformAuditEvent[]): TimelineEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.created_at < b.e.created_at ? 1 : a.e.created_at > b.e.created_at ? -1 : a.i - b.i))
    .map(({ e, i }) => toTimelineEvent(e, i));
}

// ── Domain claim (handoff §6.3 Domain) ──

export const DOMAIN_CLAIM_PILL: Readonly<Record<string, PillSpec>> = {
  PROVISIONAL: { label: 'Provisional', tone: 'info' },
  AUTHORITATIVE: { label: 'Authoritative', tone: 'ok' },
  LAPSED: { label: 'Lapsed', tone: 'warn' },
  RELEASED: { label: 'Released', tone: 'muted' },
};

export function domainClaimPill(claim: string): PillSpec {
  return DOMAIN_CLAIM_PILL[claim] ?? { label: reasonLabel(claim), tone: 'neutral' };
}

/** The claim reason codes DomainClaimService records; free text (a release reason) shows as written. */
export const DOMAIN_REASON_LABEL: Readonly<Record<string, string>> = {
  provisioned: 'Owner email domain at provisioning',
  domain_verified: 'Verified by the tenant’s DNS record',
  operator_evidence: 'Promoted with operator evidence',
  reservation_expired: 'Provisional claim expired without promotion',
};

export function domainReasonLabel(reason: string | null): string {
  if (reason === null || reason.trim() === '') return 'None recorded';
  return DOMAIN_REASON_LABEL[reason] ?? reason;
}

// ── Aramo Sign (handoff §6.3 Aramo Sign) ──

export const SUBSCRIPTION_PILL: Readonly<Record<string, PillSpec>> = {
  TRIALING: { label: 'Trialing', tone: 'info' },
  ACTIVE: { label: 'Active', tone: 'ok' },
  PAST_DUE: { label: 'Past due', tone: 'warn' },
  CANCELED: { label: 'Canceled', tone: 'muted' },
  INCOMPLETE: { label: 'Incomplete', tone: 'warn' },
  NONE: { label: 'No subscription', tone: 'neutral' },
};

export function subscriptionPill(status: string): PillSpec {
  return SUBSCRIPTION_PILL[status] ?? { label: reasonLabel(status), tone: 'neutral' };
}

export const SUBSCRIPTION_SOURCE_LABEL: Readonly<Record<string, string>> = {
  MANUAL: 'Manual (contract)',
  DEVELOPMENT: 'Development',
  SELF_SERVICE: 'Self-service',
  FREE: 'Free (Sign Personal)',
};

export function subscriptionSourceLabel(source: string): string {
  return SUBSCRIPTION_SOURCE_LABEL[source] ?? reasonLabel(source);
}

export const BILLING_OUTCOME_PILL: Readonly<Record<string, PillSpec>> = {
  APPLIED: { label: 'Applied', tone: 'ok' },
  IGNORED: { label: 'Ignored', tone: 'neutral' },
  STALE: { label: 'Stale', tone: 'warn' },
};

export function billingOutcomePill(outcome: string): PillSpec {
  return BILLING_OUTCOME_PILL[outcome] ?? { label: reasonLabel(outcome), tone: 'neutral' };
}

// Billing provider event types, matched on their suffix (the provider prefixes
// some with an object namespace).
const BILLING_EVENT_SUFFIX: readonly (readonly [string, string])[] = [
  ['invoice.paid', 'Invoice paid'],
  ['invoice.payment_succeeded', 'Invoice paid'],
  ['invoice.payment_failed', 'Payment failed'],
  ['subscription.created', 'Subscription created'],
  ['subscription.updated', 'Subscription updated'],
  ['subscription.deleted', 'Subscription ended'],
  ['checkout.session.completed', 'Checkout completed'],
];

export function billingEventLabel(eventType: string): string {
  const hit = BILLING_EVENT_SUFFIX.find(([suffix]) => eventType === suffix || eventType.endsWith(`.${suffix}`));
  if (hit) return hit[1];
  const tail = eventType.split('.').slice(-2).join(' ');
  return reasonLabel(tail);
}
