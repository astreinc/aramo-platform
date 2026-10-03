// SW-5 — PRESENTATION mappers for the Submittal Workspace. Pure functions that
// project server-authoritative facts into display shapes. They carry NO business
// truth: no mapper decides readiness, authority, eligibility, or lifecycle — those
// are read verbatim from the SW-4 payload. Icon/label/route mapping only.

import type { PillTone } from '../ui';

import type {
  SubmittalReadiness,
  SubmittalRequirement,
  SubmittalWorkspaceView,
} from './submittal-workspace-types';

export interface PillModel {
  readonly tone: PillTone;
  readonly label: string;
}

// Submittal lifecycle → header pill (the lifecycle axis, distinct from readiness).
export function lifecyclePill(state: string): PillModel {
  switch (state) {
    case 'ready_for_review':
      return { tone: 'info', label: 'Ready for review' };
    case 'submitted_to_client':
      return { tone: 'ok', label: 'Submitted to client' };
    case 'confirmed':
      return { tone: 'ok', label: 'Confirmed' };
    case 'revoked':
      return { tone: 'neutral', label: 'Revoked' };
    case 'created':
    case 'handoff_draft':
    default:
      return { tone: 'warn', label: 'Preparing' };
  }
}

const CLIENT_SELECTION_PILLS: Record<string, PillModel> = {
  CLIENT_REVIEW: { tone: 'info', label: 'Client review' },
  INTERVIEW: { tone: 'brand', label: 'Interview' },
  SELECTED: { tone: 'ok', label: 'Selected' },
  DECLINED: { tone: 'danger', label: 'Declined' },
  WITHDRAWN: { tone: 'neutral', label: 'Withdrawn' },
};

export function clientSelectionPill(state: string | null): PillModel | null {
  if (state === null) return null;
  return CLIENT_SELECTION_PILLS[state] ?? { tone: 'neutral', label: titleCase(state) };
}

const DELIVERY_LABELS: Record<string, string> = {
  manual_vms: 'Manual VMS',
  manual_client_portal: 'Client portal',
  manual_email: 'Email (outside Aramo)',
  manual_other: 'Other manual method',
  aramo_connector: 'Aramo connector',
};

export function deliveryLabel(channel: string | null): string {
  if (channel === null) return 'Not recorded';
  return DELIVERY_LABELS[channel] ?? titleCase(channel);
}

// A read-only (historical) submittal — preparation controls are hidden and
// satisfied requirements read "Met at handoff".
export function isHistorical(state: string): boolean {
  return state === 'submitted_to_client' || state === 'revoked' || state === 'confirmed';
}

export interface RequirementRowModel {
  readonly mark: string;
  readonly statusText: string;
  readonly statusTone: 'ok' | 'warn' | 'muted';
  readonly tint: 'ok' | 'warn' | 'muted';
}

// Per-requirement presentation. Driven entirely by the server's `satisfied` flag +
// the submittal's historical-ness — never by the requirement key.
export function requirementRow(req: SubmittalRequirement, historical: boolean): RequirementRowModel {
  if (req.satisfied) {
    return historical
      ? { mark: '✓', statusText: 'Met at handoff', statusTone: 'muted', tint: 'muted' }
      : { mark: '✓', statusText: 'Complete', statusTone: 'ok', tint: 'ok' };
  }
  return { mark: '!', statusText: 'Needs attention', statusTone: 'warn', tint: 'warn' };
}

// §13 — display-only completion count. The FE may count satisfied required rows;
// it must NOT convert that into readiness (readiness.status is authoritative).
export function requiredCounts(readiness: SubmittalReadiness): { done: number; total: number } {
  const required = readiness.requirements.filter((r) => r.required);
  return { done: required.filter((r) => r.satisfied).length, total: required.length };
}

// Requirement sources whose remediation is resolved on the requisition surface.
// Used ONLY to decide whether to offer an "Open requisition" navigation link; it
// never affects whether the requirement blocks (that is the server's call).
const REQUISITION_SCOPED_SOURCES = new Set<string>([
  'requisition',
  'submittal_policy',
  'client_submittal_policy',
  'client_talent_restriction',
  'documents',
]);

export function remediationOnRequisition(req: SubmittalRequirement): boolean {
  return !req.satisfied && REQUISITION_SCOPED_SOURCES.has(req.source);
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// The entry-point destination for a (talent, requisition): the Submittal Workspace
// for an existing submittal, or the wizard create route when none exists yet.
export function submittalEntryHref(
  talentId: string,
  requisitionId: string,
  state: string | null,
): string {
  return state === null
    ? `/talent/${talentId}/submittal/${requisitionId}`
    : `/talent/${talentId}/submittal/${requisitionId}/workspace`;
}

// Lifecycle-aware entry label (§8) given the current submittal state. `null` state
// = no submittal yet → "Prepare submittal" (the create entry).
export function entryActionLabel(state: string | null): string {
  switch (state) {
    case null:
      return 'Prepare submittal';
    case 'created':
    case 'handoff_draft':
      return 'Continue preparation';
    case 'ready_for_review':
      return 'Review submittal';
    case 'submitted_to_client':
    case 'confirmed':
    case 'revoked':
      return 'View submittal';
    default:
      return 'View submittal';
  }
}
