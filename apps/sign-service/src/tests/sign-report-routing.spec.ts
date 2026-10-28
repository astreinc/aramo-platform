import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ABUSE_REPORT_CONFIG, type AbuseReportContext } from '@aramo/sign';

import { ABUSE_RESTRICTION_REASON, ReportBudget, SignReportService } from '../app/personal/sign-report.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §5.2 (R-11) — report routing by sender kind.
// Business: recorded and left OPEN for the operators' queue, never a pause.
// Personal: the existing automatic pause rules, unchanged.

const TOKEN = 'A'.repeat(43);
const BINDING = '0190a6c2-1111-7000-8000-000000000001';
const CTX: AbuseReportContext = { tenant_id: 't-1', envelope_id: 'e-1', signer_id: 's-1', signer_email: 'pat@example.org' };
const CFG = { ...DEFAULT_ABUSE_REPORT_CONFIG, threshold: 4 };

function setup(kind: 'PERSONAL' | 'BUSINESS', total = 9) {
  const reports = {
    resolveReportContext: vi.fn(async () => CTX),
    resolveInboxReportContext: vi.fn(async (_user: string, id: string) => (id === BINDING ? CTX : null)),
    record: vi.fn(async () => ({ kind: 'recorded' as const, report_id: 'r-1', weight: { severity: 3, independence: 1, credibility: 1, weight: 3 }, tenant_total: total })),
    markTriggeredRestriction: vi.fn(async () => undefined),
  };
  const tenants = { findById: vi.fn(async () => ({ id: 't-1', kind })) };
  const risk = { restrict: vi.fn(async () => ({ restricted_until: new Date() })) };
  const svc = new SignReportService(reports as never, tenants as never, risk as never, new ReportBudget());
  return { svc, reports, risk };
}

describe('M-A7 §5.2 — report routing', () => {
  it('a Business sender: the report is recorded for operators and never pauses the tenant, however heavy', async () => {
    const { svc, reports, risk } = setup('BUSINESS', 99);
    await expect(svc.submit({ token: TOKEN, reason: 'phishing' }, '198.51.100.1', 'req', new Date(), CFG)).resolves.toEqual({ received: true });
    expect(reports.record).toHaveBeenCalledWith(expect.objectContaining({ context: CTX, reason: 'phishing' }));
    expect(risk.restrict).not.toHaveBeenCalled();
    expect(reports.markTriggeredRestriction).not.toHaveBeenCalled();
  });

  it('a Personal sender: the existing pause at the threshold is unchanged', async () => {
    const { svc, risk, reports } = setup('PERSONAL', 4);
    await svc.submit({ token: TOKEN, reason: 'phishing' }, '198.51.100.1', 'req', new Date(), CFG);
    expect(risk.restrict).toHaveBeenCalledWith('t-1', ABUSE_RESTRICTION_REASON, expect.any(Date), null, expect.any(Date));
    expect(reports.markTriggeredRestriction).toHaveBeenCalledWith('r-1');
    const below = setup('PERSONAL', 3);
    await below.svc.submit({ token: TOKEN }, '198.51.100.1', 'req', new Date(), CFG);
    expect(below.risk.restrict).not.toHaveBeenCalled();
  });

  it('the app’s inbox report reaches the same flow, keyed by the user’s own inbox item', async () => {
    const { svc, reports, risk } = setup('BUSINESS');
    await expect(svc.submitFromInbox('user-1', BINDING, { reason: 'spam', note: '  odd  ' }, 'req', new Date(), CFG)).resolves.toEqual({ received: true });
    expect(reports.resolveInboxReportContext).toHaveBeenCalledWith('user-1', BINDING);
    expect(reports.record).toHaveBeenCalledWith(expect.objectContaining({ context: CTX, reason: 'spam', note: 'odd' }));
    expect(risk.restrict).not.toHaveBeenCalled();
    // Not the user's item (or not an id at all): not found, nothing recorded.
    const other = setup('BUSINESS');
    await expect(other.svc.submitFromInbox('user-1', '0190a6c2-1111-7000-8000-000000000002', {}, 'req')).rejects.toMatchObject({ statusCode: 404 });
    await expect(other.svc.submitFromInbox('user-1', 'not-a-uuid', {}, 'req')).rejects.toMatchObject({ statusCode: 404 });
    await expect(other.svc.submitFromInbox('user-1', BINDING, { reason: 'nonsense' }, 'req')).rejects.toMatchObject({ statusCode: 400 });
    expect(other.reports.record).not.toHaveBeenCalled();
  });

  it('a duplicate report is a 409 for either sender kind', async () => {
    for (const kind of ['PERSONAL', 'BUSINESS'] as const) {
      const { svc, reports } = setup(kind);
      reports.record.mockResolvedValueOnce({ kind: 'duplicate' } as never);
      await expect(svc.submit({ token: TOKEN }, null, 'req', new Date(), CFG)).rejects.toMatchObject({ statusCode: 409 });
    }
  });
});
