import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';

import { SIGN_REPORTS_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import {
  AUDIT_EXPORT_MAX_ROWS,
  SenderReportsService,
  csvCell,
  periodStarts,
  resolveRange,
  statsView,
  toCsv,
} from '../app/sender/sender-reports.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED, 2bd74ca5) §1.13 — basic reports.
//   - plan capability sign.reports in BOTH states (production registry = NOT_AVAILABLE, dark);
//   - sign:report:read and a BUSINESS tenant (plans B+) before any database read;
//   - tenant_id only from the auth context;
//   - the audit export never leaks purged / redacted data, never carries recipient identities;
//   - range / period validation, zero-filled volume series, CSV quoting and injection guard.

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';
const OTHER = '33333333-3333-7333-8333-333333333333';
const TPL = '44444444-4444-7444-8444-444444444444';
const AVAILABLE = { [SIGN_REPORTS_FEATURE]: 'AVAILABLE' as const };
const NOW = new Date('2026-11-01T12:00:00.000Z');

function auth(scopes: string[] = ['sign:envelope:read', 'sign:envelope:read:all', 'sign:report:read']): AuthContextType {
  return { sub: USER, tenant_id: TENANT, scopes, consumer_type: 'sign' } as unknown as AuthContextType;
}

const ZERO = { sent: 0, completed: 0, declined: 0, voided: 0, expired: 0, in_flight: 0, turnaround_avg_seconds: null, turnaround_median_seconds: null, turnaround_p90_seconds: null };

function harness(opts: { registry?: Record<string, 'AVAILABLE' | 'NOT_AVAILABLE'>; kind?: string; audit?: unknown[] } = {}) {
  const repo = {
    cohort: vi.fn(async () => ({ ...ZERO, sent: 4, completed: 3, in_flight: 1, turnaround_avg_seconds: 7200, turnaround_median_seconds: 3600, turnaround_p90_seconds: 10_800 })),
    cohortBy: vi.fn(async (_r: unknown, group: string) =>
      group === 'sender'
        ? [{ key: USER, ...ZERO, sent: 3, completed: 2, turnaround_median_seconds: 5400 }, { key: OTHER, ...ZERO, sent: 1, completed: 1 }]
        : [{ key: TPL, ...ZERO, sent: 2, completed: 2 }, { key: null, ...ZERO, sent: 2, completed: 1 }],
    ),
    volume: vi.fn(async () => [{ period_start: new Date('2026-10-01T00:00:00.000Z'), sent: 4, completed: 3, declined: 0, voided: 0 }]),
    auditEnvelopes: vi.fn(async () => opts.audit ?? []),
  };
  const context = { tenantKind: vi.fn(async () => opts.kind ?? 'BUSINESS') };
  const identity = {
    findUserById: vi.fn(async (id: string) => (id === USER ? { id, display_name: 'Asha Rao', email: 'asha@astre.test' } : null)),
  };
  const svc = new SenderReportsService(repo as never, context as unknown as SenderContextService, identity as never, new SignFeatureGate(opts.registry));
  return { svc, repo, context, identity };
}

describe('plan capability sign.reports — NOT_AVAILABLE (the production registry)', () => {
  it('the production registry keeps sign.reports NOT_AVAILABLE and leaves sign.advanced_analytics untouched', () => {
    expect(FEATURE_AVAILABILITY['sign.reports']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.advanced_analytics']).toBe('NOT_AVAILABLE');
    expect(new SignFeatureGate().isAvailable(SIGN_REPORTS_FEATURE)).toBe(false);
  });

  it('refuses overview / export / audit export with ESIGN_FEATURE_NOT_AVAILABLE (403) before any read', async () => {
    const h = harness();
    await expect(h.svc.overview(auth(), {}, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', statusCode: 403 });
    await expect(h.svc.exportCsv(auth(), {}, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    await expect(h.svc.auditExport(auth(), {}, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    expect(h.repo.cohort).not.toHaveBeenCalled();
    expect(h.repo.auditEnvelopes).not.toHaveBeenCalled();
    expect(h.context.tenantKind).not.toHaveBeenCalled();
    expect(h.svc.available()).toBe(false);
  });
});

describe('plan capability sign.reports — AVAILABLE (test registry)', () => {
  it('refuses a session without sign:report:read (a Sign Sender) before any read', async () => {
    const h = harness({ registry: AVAILABLE });
    await expect(h.svc.overview(auth(['sign:envelope:read', 'sign:envelope:create']), {}, 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(h.repo.cohort).not.toHaveBeenCalled();
  });

  it('refuses a PERSONAL tenant (plans B+ only) before any read', async () => {
    const h = harness({ registry: AVAILABLE, kind: 'PERSONAL' });
    await expect(h.svc.overview(auth(), {}, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', context: { details: { reason: 'business_plans_only' } } });
    expect(h.repo.cohort).not.toHaveBeenCalled();
  });

  it('builds the overview for the session tenant only, with rates, hours and named senders', async () => {
    const h = harness({ registry: AVAILABLE });
    const o = await h.svc.overview(auth(), { from: '2026-09-01', to: '2026-10-31', period: 'month' }, 'r');
    const range = (h.repo.cohort.mock.calls[0] as unknown[])[0] as { tenant_id: string; from: Date; to: Date };
    expect(range.tenant_id).toBe(TENANT);
    expect(range.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(o.range).toEqual({ from: '2026-09-01', to: '2026-10-31', period: 'month', timezone: 'UTC' });
    expect(o.totals).toMatchObject({ sent: 4, completed: 3, in_flight: 1, completion_rate: 75, turnaround_average_hours: 2, turnaround_median_hours: 1, turnaround_p90_hours: 3 });
    expect(o.volume).toEqual([
      { period_start: '2026-09-01', sent: 0, completed: 0, declined: 0, voided: 0 },
      { period_start: '2026-10-01', sent: 4, completed: 3, declined: 0, voided: 0 },
    ]);
    expect(o.by_sender).toEqual([
      expect.objectContaining({ sender_id: USER, sender_name: 'Asha Rao', sent: 3, completed: 2, completion_rate: 66.7, turnaround_median_hours: 1.5 }),
      expect.objectContaining({ sender_id: OTHER, sender_name: null, sent: 1, completed: 1, completion_rate: 100 }),
    ]);
    expect(o.by_template).toEqual([
      expect.objectContaining({ template_ref: TPL, template_name: null, sent: 2 }),
      expect.objectContaining({ template_ref: null, template_name: null, sent: 2 }),
    ]);
  });

  it('exports each table as CSV', async () => {
    const h = harness({ registry: AVAILABLE });
    const q = { from: '2026-10-01', to: '2026-10-31' };
    const senders = await h.svc.exportCsv(auth(), { ...q, report: 'senders' }, 'r');
    expect(senders.filename).toBe('aramo-sign-senders-2026-10-01-to-2026-10-31.csv');
    expect(senders.body.split('\r\n')[0]).toBe(
      'sender_id,sender_name,sent,completed,declined,voided,expired,in_flight,completion_rate_percent,turnaround_average_hours,turnaround_median_hours,turnaround_p90_hours',
    );
    expect(senders.body).toContain(`${USER},Asha Rao,3,2,0,0,0,0,66.7,,1.5,`);
    const summary = await h.svc.exportCsv(auth(), q, 'r');
    expect(summary.body.split('\r\n')[1]).toBe('2026-10-01,2026-10-31,4,3,0,0,0,1,75,2,1,3');
    const volume = await h.svc.exportCsv(auth(), { ...q, report: 'volume' }, 'r');
    expect(volume.body).toBe('period_start,sent,completed,declined,voided\r\n2026-10-01,4,3,0,0\r\n');
    const templates = await h.svc.exportCsv(auth(), { ...q, report: 'templates' }, 'r');
    expect(templates.body.split('\r\n')[2]).toMatch(/^,,2,1,/);
    await expect(h.svc.exportCsv(auth(), { ...q, report: 'everything' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('the audit export masks a purged subject and a redacted sender, and never carries recipient identities', async () => {
    const base = {
      status: 'COMPLETED', created_by: USER, source_application: 'aramo-sign', template_ref: null,
      created_at: new Date('2026-10-02T00:00:00Z'), sent_at: new Date('2026-10-02T01:00:00Z'), completed_at: new Date('2026-10-03T01:00:00Z'),
      declined_at: null, voided_at: null, recipients: 2, signed: 2, purge_state: null, purge_level: null, purge_executed_at: null,
    };
    const h = harness({
      registry: AVAILABLE,
      audit: [
        { ...base, id: 'e1', subject: 'Offer for Jane' },
        { ...base, id: 'e2', subject: 'Queued, documents only', purge_state: 'EXECUTED', purge_level: 'DOCUMENTS', purge_executed_at: new Date('2026-10-20T00:00:00Z') },
        { ...base, id: 'e3', subject: 'Offer for Raj', purge_state: 'EXECUTED', purge_level: 'DOCUMENTS_AND_METADATA', purge_executed_at: new Date('2026-10-20T00:00:00Z') },
        { ...base, id: 'e4', subject: 'Offer for Lee', purge_state: 'EXECUTED', purge_level: 'DOCUMENTS_AND_METADATA_AND_REDACT', purge_executed_at: new Date('2026-10-20T00:00:00Z') },
        { ...base, id: 'e5', subject: 'Offer for Kim', purge_state: 'QUEUED', purge_level: 'DOCUMENTS_AND_METADATA_AND_REDACT' },
      ],
    });
    const out = await h.svc.auditExport(auth(), { from: '2026-10-01', to: '2026-10-31' }, 'r');
    const lines = out.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'envelope_id,subject,status,sender_id,sender_name,source_application,template_ref,created_at,sent_at,completed_at,declined_at,voided_at,recipients,signed,purge_state,purge_level,purge_executed_at',
    );
    expect(lines[0]).not.toMatch(/email|recipient_name|signer_name/);
    expect(lines[1]).toMatch(/^e1,Offer for Jane,COMPLETED,.*,Asha Rao,aramo-sign,,2026-10-02T00:00:00.000Z,/);
    expect(lines[2]).toMatch(/^e2,"?Queued, documents only"?,/);
    expect(lines[3]).toMatch(/^e3,\[purged\],COMPLETED,.*,Asha Rao,/);
    expect(lines[4]).toMatch(new RegExp(`^e4,\\[purged\\],COMPLETED,${USER},,aramo-sign,`));
    expect(out.body).not.toContain('Raj');
    expect(out.body).not.toContain('Lee');
    // A purge that is only queued has not run: the row is still the organization's data.
    expect(lines[5]).toMatch(/^e5,Offer for Kim,/);
    expect(out.filename).toBe('aramo-sign-envelope-audit-2026-10-01-to-2026-10-31.csv');
    expect(h.repo.auditEnvelopes).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT }), AUDIT_EXPORT_MAX_ROWS + 1);
  });

  it('refuses an audit export over the row cap rather than truncating it silently', async () => {
    const many = Array.from({ length: AUDIT_EXPORT_MAX_ROWS + 1 }, (_, i) => ({ id: `e${i}`, created_by: USER }));
    const h = harness({ registry: AVAILABLE, audit: many });
    await expect(h.svc.auditExport(auth(), {}, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'too_many_rows' } } });
  });
});

describe('report range', () => {
  it('defaults to six calendar months ending today (UTC), monthly', () => {
    const r = resolveRange(TENANT, {}, 'r', NOW);
    expect(r).toMatchObject({ from_date: '2026-06-01', to_date: '2026-11-01', period: 'month' });
    expect(r.to.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('rejects bad dates, reversed ranges, unknown periods and over-long ranges', () => {
    expect(() => resolveRange(TENANT, { from: '2026-13-01' }, 'r', NOW)).toThrow(/valid date/);
    expect(() => resolveRange(TENANT, { from: '10/01/2026' }, 'r', NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRange(TENANT, { from: '2026-10-02', to: '2026-10-01' }, 'r', NOW)).toThrow(/on or before/);
    expect(() => resolveRange(TENANT, { period: 'year' }, 'r', NOW)).toThrow(/day, week or month/);
    expect(() => resolveRange(TENANT, { from: '2024-01-01', to: '2026-10-31' }, 'r', NOW)).toThrow(/at most 731 days/);
    expect(() => resolveRange(TENANT, { from: '2025-01-01', to: '2026-10-31', period: 'day' }, 'r', NOW)).toThrow(/daily report/);
    expect(resolveRange(TENANT, { from: '2026-10-31', to: '2026-10-31', period: 'day' }, 'r', NOW).from_date).toBe('2026-10-31');
  });

  it('period starts match Postgres date_trunc (weeks start Monday)', () => {
    const from = new Date('2026-10-01T00:00:00Z'); // a Thursday
    const to = new Date('2026-10-16T00:00:00Z');
    expect(periodStarts(from, to, 'week')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    expect(periodStarts(from, new Date('2026-10-04T00:00:00Z'), 'day')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(periodStarts(new Date('2026-11-15T00:00:00Z'), new Date('2027-02-01T00:00:00Z'), 'month')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
  });
});

describe('report formatting', () => {
  it('completion rate is null when nothing was sent', () => {
    expect(statsView({ ...ZERO }).completion_rate).toBeNull();
  });

  it('CSV cells are RFC 4180 quoted and formula-guarded', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x\ny']])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});
