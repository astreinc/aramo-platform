import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { financeAmountAccess, withholdAuditPayloadAmounts } from '../billing/finance-amount-withholding.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { COMMERCIAL_AUDIT_MAX_LIMIT, CommercialAuditRepository, type CommercialAuditEventRow, type CommercialAuditQuery } from './commercial-audit.repository.js';
import type { CommercialActor, CommercialCallContext } from './commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';
import { CommercialPolicyRepository } from './commercial-policy.repository.js';
import { canonicalJson } from './commercial-policy.js';

// CCP-B5 (handoff §5.7; PBD §5.3 B5 row "audit explorer with export"; pre-execution C-5) —
// the READ-ONLY CSV export of the commercial audit stream, "itself an audit event".
//
// The export reads the filtered CommercialAuditEvent rows (the A2 repository, newest first),
// renders them as CSV server-side, and then appends exactly ONE COMMERCIAL_AUDIT_EXPORTED
// event (who, when, which filters, how many rows, the SHA-256 of the file). It writes nothing
// else: no audit row is changed (the A2 trigger forbids it anyway) and no other table is
// touched. The export is bounded (COMMERCIAL_AUDIT_EXPORT_MAX_ROWS); a larger result is
// refused, never truncated silently.
//
// Columns (handoff §5.7): id,time_utc,event,actor,roles,tenant,product,change_request,
// exception,detail. The file is a record, not a rendering: `event` is the event code,
// `roles` the role keys at the time, `detail` the canonical JSON of the event payload. Every
// field is quoted; a field starting with = + - @ (or a tab / carriage return) is prefixed
// with an apostrophe so a spreadsheet never evaluates it (CSV formula injection).

export const COMMERCIAL_AUDIT_EXPORT_MAX_ROWS = 10_000;
export const COMMERCIAL_AUDIT_EXPORT_COLUMNS = ['id', 'time_utc', 'event', 'actor', 'roles', 'tenant', 'product', 'change_request', 'exception', 'detail'] as const;

export type CommercialAuditExportQuery = Omit<CommercialAuditQuery, 'limit' | 'cursor'>;

export class CommercialAuditExportTooLargeError extends Error {
  constructor(readonly max_rows: number) {
    super(`the export would exceed ${max_rows} events; narrow the filters`);
    this.name = 'CommercialAuditExportTooLargeError';
  }
}

export interface CommercialAuditExportResult {
  export_id: string;
  exported_at: Date;
  row_count: number;
  filename: string;
  csv: string;
  csv_sha256: string;
}

/** Pure: one CSV field, always quoted, formula-safe. */
export function csvField(value: string | null | undefined): string {
  let v = value ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

export interface AuditExportNames {
  /** user id → display name, else email. */
  actors: ReadonlyMap<string, string>;
  /** tenant id → tenant name. */
  tenants: ReadonlyMap<string, string>;
  /** CCP-R3 (CCP-A1 Amendment A1): the exporter holds platform:billing:read AND platform:billing:amount:read. */
  amount_access?: boolean;
}

/** Pure: the CSV document (header + one line per event, CRLF line ends per RFC 4180). */
export function buildAuditCsv(rows: readonly CommercialAuditEventRow[], names: AuditExportNames): string {
  const lines = [COMMERCIAL_AUDIT_EXPORT_COLUMNS.join(',')];
  for (const r of rows) {
    // CCP-R3 (CCP-A1 Amendment A1, FA-1 "invoice exports", FA-5): the `detail` column carries a
    // tenant-specific amount only for a caller holding platform:billing:amount:read too.
    const payload = withholdAuditPayloadAmounts((r.payload ?? {}) as Record<string, unknown>, names.amount_access === true);
    const product = typeof payload['product_key'] === 'string' ? (payload['product_key'] as string) : '';
    const actor = r.actor_id === null ? r.actor_type : (names.actors.get(r.actor_id) ?? r.actor_id);
    const tenant = r.tenant_id === null ? '' : (names.tenants.get(r.tenant_id) ?? r.tenant_id);
    lines.push(
      [
        r.id,
        r.created_at.toISOString(),
        r.event_type,
        actor,
        [...r.actor_role_keys].join(' '),
        tenant,
        product,
        r.change_request_id ?? '',
        r.is_exception ? 'yes' : '',
        canonicalJson(payload),
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

@Injectable()
export class CommercialAuditExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly policies: CommercialPolicyRepository,
    private readonly operators: CommercialOperatorRepository,
  ) {}

  async export(actor: CommercialActor, query: CommercialAuditExportQuery, ctx: CommercialCallContext, now: Date = new Date()): Promise<CommercialAuditExportResult> {
    const rows: CommercialAuditEventRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.audit.list({ ...query, limit: COMMERCIAL_AUDIT_MAX_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
      rows.push(...page.events);
      if (rows.length > COMMERCIAL_AUDIT_EXPORT_MAX_ROWS) throw new CommercialAuditExportTooLargeError(COMMERCIAL_AUDIT_EXPORT_MAX_ROWS);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((x): x is string => x !== null))];
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter((x): x is string => x !== null))];
    const actors = new Map<string, string>();
    if (actorIds.length > 0) {
      const users = await this.prisma.$queryRawUnsafe<Array<{ id: string; email: string; display_name: string | null }>>(
        `SELECT id::text AS id, email, display_name FROM identity."User" WHERE id = ANY($1::uuid[])`,
        actorIds,
      );
      for (const u of users) actors.set(u.id, u.display_name?.trim() ? u.display_name.trim() : u.email);
    }
    const tenants = new Map<string, string>();
    if (tenantIds.length > 0) {
      const ts = await this.prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(`SELECT id::text AS id, name FROM identity."Tenant" WHERE id = ANY($1::uuid[])`, tenantIds);
      for (const t of ts) tenants.set(t.id, t.name);
    }
    const amount_access = financeAmountAccess(actor.scopes);
    const csv = buildAuditCsv(rows, { actors, tenants, amount_access });
    const csv_sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
    const export_id = uuidv7();
    const policy = await this.policies.getActivePolicy();
    const live = await this.operators.readOperator(this.prisma, ctx.platform_tenant_id, actor.user_id);
    const filters = Object.fromEntries(
      Object.entries({ ...query, from: query.from?.toISOString(), to: query.to?.toISOString() }).filter(([, v]) => v !== undefined && v !== false),
    );
    const event = await this.audit.append({
      actor: { id: actor.user_id, type: 'user', role_keys: live.role_keys },
      event_type: 'COMMERCIAL_AUDIT_EXPORTED',
      subject: `commercial_audit_export:${export_id}`,
      policy_version_id: policy.version_id,
      payload: { format: 'csv', row_count: rows.length, filters, csv_sha256, columns: [...COMMERCIAL_AUDIT_EXPORT_COLUMNS], amounts: amount_access ? 'INCLUDED' : 'WITHHELD' },
      correlation_id: ctx.correlation_id,
    });
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    return { export_id, exported_at: event.created_at, row_count: rows.length, filename: `commercial-audit-${stamp}.csv`, csv, csv_sha256 };
  }
}
