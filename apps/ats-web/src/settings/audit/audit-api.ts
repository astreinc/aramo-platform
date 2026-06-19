// Settings Rebuild Directive 2 — audit-log read API client.
//
//   GET /v1/tenant/audit-events?limit&cursor&event_type&actor_id&subject_id&from&to
//     -> { items: AuditEventView[], next_cursor }
//
// Gates on audit:read (seeded to tenant_admin + tenant_owner this PR).

import { apiClient } from '@aramo/fe-foundation';

import type { AuditFilters, AuditQueryResult } from './types';

export const AUDIT_EVENTS_PATH = '/v1/tenant/audit-events';

export const PAGE_SIZE = 50;

export async function fetchAuditEvents(args: {
  readonly filters?: AuditFilters;
  readonly cursor?: string | null;
  readonly limit?: number;
}): Promise<AuditQueryResult> {
  const params = new URLSearchParams();
  params.set('limit', String(args.limit ?? PAGE_SIZE));
  if (args.cursor) params.set('cursor', args.cursor);
  const f = args.filters ?? {};
  if (f.event_type) params.set('event_type', f.event_type);
  if (f.actor_id) params.set('actor_id', f.actor_id);
  if (f.subject_id) params.set('subject_id', f.subject_id);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  return apiClient.get<AuditQueryResult>(`${AUDIT_EVENTS_PATH}?${params.toString()}`);
}
