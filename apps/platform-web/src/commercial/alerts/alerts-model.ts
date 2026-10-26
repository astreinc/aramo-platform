// CCP-UI-V12 — the pure model behind Operations › Alerts (CCP-UI v1.1 handoff §13.6; v1.2 §17.1
// D-2, §17.2). The register is the server's; the console only labels it. Severity is operational
// only: it never grades, rates or orders tenants or people.

import type { PlatformTone } from '../../components';
import { actionLabel } from '../commercial-model';
import { commandKindLabel, productName, shortRef, stampLabel } from '../finance/finance-model';

import type { CommercialAlert } from './alerts-api';

export type Severity = 'ACTION_NEEDED' | 'WATCH';

/**
 * The design's type label and operational severity per alert type (Commercial Control Plane
 * v1.2.dc.html `ald`). The register carries no severity field (MBC-V12-8): the severity is the
 * design's fixed value for the type. ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION (CCP-R3) is not in the
 * design (DV-V12-12): "Action needed", as access is refused while the entitlement stays active.
 */
export const ALERT_TYPE: Readonly<Record<string, { readonly label: string; readonly severity: Severity }>> = {
  COMMAND_PENDING_PROVIDER_STUCK: { label: 'Stripe command stuck pending', severity: 'ACTION_NEEDED' },
  COMMAND_FAILED: { label: 'Stripe command failed', severity: 'ACTION_NEEDED' },
  HELD_ACTIVATION: { label: 'Held activation open', severity: 'WATCH' },
  WEBHOOK_INBOX_FAILED: { label: 'Inbox processing failure', severity: 'ACTION_NEEDED' },
  USAGE_NOT_RECONCILED: { label: 'Usage roll-ups not reconciled', severity: 'WATCH' },
  ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION: { label: 'Entitlement without an active subscription', severity: 'ACTION_NEEDED' },
  APPLY_FAILED: { label: 'Change request apply failed', severity: 'ACTION_NEEDED' },
  APPROVAL_NEARING_EXPIRY: { label: 'Approval request near expiry', severity: 'WATCH' },
  APPROVAL_PAST_EXPIRY: { label: 'Approval request past expiry', severity: 'WATCH' },
  APPLY_DEADLINE_NEARING: { label: 'Approved request near its apply deadline', severity: 'ACTION_NEEDED' },
  APPLY_DEADLINE_PASSED: { label: 'Approved request past its apply deadline', severity: 'WATCH' },
};

export function alertType(t: string): { readonly label: string; readonly severity: Severity } {
  return ALERT_TYPE[t] ?? { label: t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' '), severity: 'WATCH' };
}

export const SEVERITY_PILL: Readonly<Record<Severity, { readonly label: string; readonly tone: PlatformTone }>> = {
  ACTION_NEEDED: { label: 'Action needed', tone: 'warn' },
  WATCH: { label: 'Watch', tone: 'neutral' },
};

export type AlertFilter = 'open' | 'resolved' | 'all';
export const ALERT_FILTERS: readonly (readonly [AlertFilter, string])[] = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];

export function passes(a: CommercialAlert, f: AlertFilter): boolean {
  return f === 'all' || (f === 'open') === (a.status === 'OPEN');
}

/** Where the subject's governed action lives (design `go`). */
export type SubjectLink = { readonly kind: 'request'; readonly id: string } | { readonly kind: 'tenant'; readonly id: string } | { readonly kind: 'route'; readonly to: string } | null;

export interface AlertRowView {
  readonly alert: CommercialAlert;
  readonly type: string;
  readonly ref: string;
  readonly severity: { readonly label: string; readonly tone: PlatformTone };
  readonly subject: string;
  readonly link: SubjectLink;
  readonly opened: string;
  readonly status: { readonly label: string; readonly tone: PlatformTone };
  readonly detail: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function alertRow(a: CommercialAlert, tenantName: (id: string) => string | null): AlertRowView {
  const t = alertType(a.alert_type);
  const tenant = a.tenant_id !== null ? (tenantName(a.tenant_id) ?? shortRef(a.tenant_id)) : null;
  const ev = a.evidence ?? {};
  let subject: string;
  let link: SubjectLink;
  switch (a.subject_kind) {
    case 'change_request': {
      const at = str(ev['action_type']);
      subject = `${shortRef(a.subject_id)}${at !== null ? ` · ${actionLabel(at)}` : ''}`;
      link = { kind: 'request', id: a.subject_id };
      break;
    }
    case 'billing_command': {
      const k = str(ev['command_kind']);
      const cr = str(ev['change_request_id']);
      subject = `${shortRef(a.subject_id)}${cr !== null ? ` · ${shortRef(cr)}` : tenant !== null ? ` · ${tenant}` : k !== null ? ` · ${commandKindLabel(k)}` : ''}`;
      link = cr !== null ? { kind: 'request', id: cr } : a.tenant_id !== null ? { kind: 'tenant', id: a.tenant_id } : { kind: 'route', to: '/commercial/finance/reconciliation' };
      break;
    }
    case 'webhook_inbox': {
      const e = str(ev['provider_event_id']);
      subject = `${e ?? shortRef(a.subject_id)}${tenant !== null ? ` · ${tenant}` : ''}`;
      link = a.tenant_id !== null ? { kind: 'tenant', id: a.tenant_id } : { kind: 'route', to: '/commercial/finance/reconciliation' };
      break;
    }
    case 'usage_metric':
      subject = 'Usage › Consumption';
      link = { kind: 'route', to: '/commercial/usage' };
      break;
    case 'product_entitlement':
      subject = `${tenant ?? '—'}${a.product_key !== null ? ` · ${productName(a.product_key)}` : ''}`;
      link = a.tenant_id !== null ? { kind: 'tenant', id: a.tenant_id } : null;
      break;
    default:
      subject = tenant ?? shortRef(a.subject_id);
      link = a.tenant_id !== null ? { kind: 'tenant', id: a.tenant_id } : null;
  }
  const open = a.status === 'OPEN';
  return {
    alert: a,
    type: t.label,
    ref: shortRef(a.id),
    severity: SEVERITY_PILL[t.severity],
    subject,
    link,
    opened: stampLabel(a.first_detected_at),
    status: open ? { label: 'Open', tone: 'info' } : { label: 'Resolved automatically', tone: 'ok' },
    detail: open ? a.detail : `Became: ${a.resolution_detail ?? 'resolved'}`,
  };
}

/** Both families, newest first (each route orders `first_detected_at DESC, id DESC`). */
export function mergeAlerts(...lists: readonly (readonly CommercialAlert[])[]): CommercialAlert[] {
  return lists
    .flat()
    .slice()
    .sort((a, b) => Date.parse(b.first_detected_at) - Date.parse(a.first_detected_at) || (a.id < b.id ? 1 : -1));
}
