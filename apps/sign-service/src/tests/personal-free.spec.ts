import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDto } from '@aramo/identity';
import { weighReport, DEFAULT_ABUSE_REPORT_CONFIG } from '@aramo/sign';

import { AramoSignAllowanceGate } from '../app/aramo-sign-allowance.gate.js';
import { renderSigningNotification, reportUrlFromSigningUrl, MailerSigningNotificationAdapter } from '../app/mailer-signing-notification.adapter.js';
import { PersonalSendGate, clientIp, hasScamWording, pdfHasLinks } from '../app/personal/personal-send.gate.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED — unit coverage of the
// Personal sending gate pieces, the report link and the weighting.

const TOKEN = 'A'.repeat(43);
const tenant = (over: Partial<TenantDto> = {}): TenantDto =>
  ({ id: 't-1', name: 'n', is_active: true, created_at: new Date().toISOString(), updated_at: '', identity_provider: null, status: 'ACTIVE', kind: 'PERSONAL', ...over }) as TenantDto;
const AUTH = { sub: 'u-1', tenant_id: 't-1', consumer_type: 'sign', actor_kind: 'user', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 0 } as never;

function gate(over: { verdict?: unknown; phoneVerified?: boolean; status?: unknown; counts?: Record<string, number>; mode?: string } = {}) {
  process.env['SIGN_PERSONAL_SIGNUP_MODE'] = over.mode ?? 'invite';
  const risk = {
    assertPersonalSendAllowed: vi.fn(async () => over.verdict ?? { ok: true }),
    phoneVerified: vi.fn(async () => over.phoneVerified ?? false),
    requireStepUp: vi.fn(async () => ({})),
    flagForReview: vi.fn(async () => ({})),
  };
  const free = { ensure: vi.fn(async () => ({ ok: true, opened: false, subscription_id: 's', source: 'FREE' })) };
  const allowance = { getStatus: vi.fn(async () => over.status ?? { subscribed: true, remaining: 5, daily: { remaining: 2 } }) };
  const geo = { countryOf: vi.fn(async (ip: string) => (ip === '198.51.100.1' ? 'US' : null)), networkKind: vi.fn() };
  const repo = { countByStatus: vi.fn(async () => over.counts ?? {}) };
  const g = new PersonalSendGate(free as never, allowance as never, risk as never, geo as never, repo as never);
  return { g, risk, free, allowance, geo };
}
const input = (over: Partial<{ subject: string; sender_name: string | null; recipient_count: number; pdfs: () => Promise<Uint8Array[]> }> = {}) => ({
  subject: 'Lease',
  document_titles: ['lease'],
  sender_name: 'Pat Example',
  recipient_count: 1,
  pdfs: async () => [],
  ...over,
});

describe('Personal Free — sending gate', () => {
  it('clientIp takes the right-most X-Forwarded-For entry (one proxy hop), else the socket peer', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.1' }, socket: { remoteAddress: '10.0.0.1' } } as never)).toBe('198.51.100.1');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never)).toBe('10.0.0.1');
  });

  it('scam wording and sender-name impersonation are detected; ordinary titles are not', () => {
    expect(hasScamWording(['Verify your account now'], 'Pat')).toBe(true);
    expect(hasScamWording(['Lease'], 'PayPal Security Team')).toBe(true);
    expect(hasScamWording(['Gift card reimbursement'], null)).toBe(true);
    expect(hasScamWording(['Apartment lease 2026', 'Addendum'], 'Pat Example')).toBe(false);
    expect(hasScamWording(['Pet policy'], 'Pat', { SIGN_PERSONAL_SEND_WORDING: 'pet policy' })).toBe(true);
  });

  it('links in a PDF: drawn text and URI link annotations; a plain PDF has none', async () => {
    const plain = await PDFDocument.create();
    plain.addPage().drawText('Hello', { font: await plain.embedFont(StandardFonts.Helvetica) });
    expect(await pdfHasLinks(await plain.save())).toBe(false);
    const text = await PDFDocument.create();
    text.addPage().drawText('pay at www.example.test', { font: await text.embedFont(StandardFonts.Helvetica) });
    expect(await pdfHasLinks(await text.save())).toBe(true);
    const annot = await PDFDocument.create();
    const page = annot.addPage();
    const link = annot.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFString.of('x') } });
    page.node.set(PDFName.of('Annots'), annot.context.obj([annot.context.register(link)]));
    expect(await pdfHasLinks(await annot.save())).toBe(true);
    expect(await pdfHasLinks(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('the risk verdict is refused with its reason; the network country comes from GeoIP (unknown → null)', async () => {
    const { g, risk } = gate({ verdict: { ok: false, reason: 'personal_location_not_supported' } });
    await expect(g.assertRiskGate('t-1', '203.0.113.9', 'r')).rejects.toMatchObject({ statusCode: 403, code: 'INSUFFICIENT_PERMISSIONS', context: { details: { reason: 'personal_location_not_supported' } } });
    expect(risk.assertPersonalSendAllowed).toHaveBeenCalledWith('t-1', expect.objectContaining({ ip_country: null }));
    const ok = gate();
    await ok.g.assertRiskGate('t-1', '198.51.100.1', 'r');
    expect(ok.risk.assertPersonalSendAllowed).toHaveBeenCalledWith('t-1', expect.objectContaining({ ip_country: 'US' }));
  });

  it('young account: wording → review; first multi-recipient send → step-up unless phone assured', async () => {
    const a = gate();
    await expect(a.g.assertMaySend(tenant(), '198.51.100.1', input({ subject: 'Urgent action required' }), 'r')).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    expect(a.risk.flagForReview).toHaveBeenCalledWith('t-1', 'young_account_wording', expect.any(Date));
    const b = gate();
    await expect(b.g.assertMaySend(tenant(), '198.51.100.1', input({ recipient_count: 2 }), 'r')).rejects.toMatchObject({ context: { details: { reason: 'phone_verification_required' } } });
    expect(b.risk.requireStepUp).toHaveBeenCalledWith('t-1', 'young_account_first_send_several_recipients', expect.any(Date));
    const c = gate({ phoneVerified: true });
    await expect(c.g.assertMaySend(tenant(), '198.51.100.1', input({ recipient_count: 2 }), 'r')).resolves.toBeUndefined();
    expect(c.risk.requireStepUp).not.toHaveBeenCalled();
  });

  it('an established account skips the young checks; an exhausted allowance skips them too (the allowance refuses)', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const a = gate({ counts: { COMPLETED: 10, DRAFT: 3 } });
    await expect(a.g.assertMaySend(tenant({ created_at: old }), '198.51.100.1', input({ subject: 'Verify your account', recipient_count: 3 }), 'r')).resolves.toBeUndefined();
    const b = gate({ status: { subscribed: true, remaining: 3, daily: { remaining: 0 } } });
    await expect(b.g.assertMaySend(tenant(), '198.51.100.1', input({ subject: 'Verify your account' }), 'r')).resolves.toBeUndefined();
    expect(b.risk.flagForReview).not.toHaveBeenCalled();
  });

  it('authoring opens only for an ACTIVE PERSONAL tenant with the mode not off', () => {
    expect(gate({ mode: 'off' }).g.authoringOpen(tenant())).toBe(false);
    expect(gate().g.authoringOpen(tenant({ status: 'PROVISIONED' }))).toBe(false);
    expect(gate().g.authoringOpen(tenant({ kind: 'BUSINESS' }))).toBe(false);
    expect(gate({ mode: 'open' }).g.authoringOpen(tenant())).toBe(true);
    delete process.env['SIGN_PERSONAL_SIGNUP_MODE'];
  });

  it('SenderContextService: mode off keeps the exact refusal; mode on lets a bound Personal tenant author and opens FREE', async () => {
    const tenants = { findById: vi.fn(async () => tenant()), findSlugById: vi.fn(async () => null), findOrganizationNameById: vi.fn(async () => null) };
    const { g, free } = gate({ mode: 'off' });
    const svc = new SenderContextService(tenants as never, { findUserById: vi.fn(async () => null) } as never, undefined, g);
    await expect(svc.assertCanAuthor(AUTH, 'r')).rejects.toMatchObject({ message: 'Sending from a personal account is not enabled', context: { details: { reason: 'personal_sending_not_enabled' } } });
    expect(free.ensure).not.toHaveBeenCalled();
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'invite';
    await expect(svc.assertCanAuthor(AUTH, 'r')).resolves.toBeUndefined();
    expect(free.ensure).toHaveBeenCalledTimes(1);
    await expect(svc.assertBusiness(AUTH, 'r')).rejects.toMatchObject({ context: { details: { reason: 'personal_sending_not_enabled' } } });
    expect(await svc.context(AUTH, 'r')).toMatchObject({ personal_sending_enabled: true, can_send: true, workspace: 'personal' });
    delete process.env['SIGN_PERSONAL_SIGNUP_MODE'];
  });
});

describe('Personal Free — "Report this email"', () => {
  it('the report URL carries the signing token in the fragment; only http(s) signing links qualify', () => {
    expect(reportUrlFromSigningUrl(`https://sign.aramo.ai/s/${TOKEN}`)).toBe(`https://sign.aramo.ai/report#token=${TOKEN}`);
    expect(reportUrlFromSigningUrl(`javascript:alert(1)/s/${TOKEN}`)).toBeNull();
    expect(reportUrlFromSigningUrl(undefined)).toBeNull();
  });

  it('only signing requests and reminders render the link', () => {
    const base = { to_email: 'x@y.test', to_name: 'X', envelope_subject: 'Lease', signing_url: `https://s.test/s/${TOKEN}` };
    expect(renderSigningNotification({ ...base, kind: 'SIGNATURE_REQUEST' }, { report_url: 'https://s.test/report#token=t' }).report?.label).toBe('Report this email');
    expect(renderSigningNotification({ ...base, kind: 'SIGNATURE_REMINDER' }, { report_url: 'https://s.test/report#token=t' }).report).toBeDefined();
    expect(renderSigningNotification({ ...base, kind: 'SIGNATURE_VOIDED' }, { report_url: 'https://s.test/report#token=t' }).report).toBeUndefined();
    expect(renderSigningNotification({ ...base, kind: 'SIGNATURE_REQUEST' }).report).toBeUndefined();
  });

  it('the mailer adds the link for a PERSONAL sender only; a lookup failure sends the email without it', async () => {
    const sent: { html: string; text: string }[] = [];
    const mailer = { send: vi.fn(async (m: { html: string; text: string }) => (sent.push(m), { message_id: 'm' })) };
    const kinds: Record<string, string> = { p: 'PERSONAL', b: 'BUSINESS' };
    const tenants = { findById: vi.fn(async (id: string) => (id === 'boom' ? Promise.reject(new Error('db')) : { kind: kinds[id] })) };
    const adapter = new MailerSigningNotificationAdapter(mailer as never, tenants as never);
    const n = { kind: 'SIGNATURE_REQUEST' as const, to_email: 'x@y.test', to_name: 'X', envelope_subject: 'Lease', signing_url: `https://s.test/s/${TOKEN}` };
    await adapter.notify({ ...n, tenant_id: 'p' });
    await adapter.notify({ ...n, tenant_id: 'b' });
    await adapter.notify({ ...n, tenant_id: 'boom' });
    await adapter.notify(n);
    expect(sent[0]!.html).toContain(`https://s.test/report#token=${TOKEN}`);
    expect(sent[0]!.text).toContain('Report this email');
    for (const m of sent.slice(1)) expect(m.html).not.toContain('Report this email');
    // Without a tenant lookup bound, the email is exactly the pre-existing one.
    const plain: { html: string }[] = [];
    await new MailerSigningNotificationAdapter({ send: async (m: { html: string }) => (plain.push(m), { message_id: 'm' }) } as never).notify({ ...n, tenant_id: 'p' });
    expect(plain[0]!.html).toBe(sent[1]!.html);
  });

  it('weighting: severity × independence × credibility', () => {
    expect(weighReport({ reason: 'phishing', sameGroup: 0, sameEnvelope: 0, falseBefore: 0 })).toEqual({ severity: 3, independence: 1, credibility: 1, weight: 3 });
    expect(weighReport({ reason: 'unknown_sender', sameGroup: 0, sameEnvelope: 0, falseBefore: 0 }).weight).toBe(0.75);
    expect(weighReport({ reason: 'spam', sameGroup: 1, sameEnvelope: 0, falseBefore: 0 }).independence).toBe(0.5);
    expect(weighReport({ reason: null, sameGroup: 0, sameEnvelope: 0, falseBefore: 2 })).toMatchObject({ credibility: 0.25, weight: 0.25 });
    expect(weighReport({ reason: 'phishing', sameGroup: 0, sameEnvelope: 0, falseBefore: 10 }).credibility).toBe(DEFAULT_ABUSE_REPORT_CONFIG.credibilityFloor);
  });
});

describe('Personal Free — allowance gate (shared with ATS)', () => {
  it('maps DAILY_LIMIT_REACHED to ESIGN_ALLOWANCE_EXHAUSTED with the day window; the monthly refusal is unchanged', async () => {
    const daily = { subscribed: true, limit: 5, used: 2, period_end: new Date('2026-11-01T00:00:00Z'), daily: { window: 'DAY', limit: 2, used: 2, remaining: 0, next_available_at: new Date('2026-10-06T09:00:00Z') } };
    const allowance = {
      resolveStale: vi.fn(async () => ({})),
      reserve: vi.fn(async () => ({ ok: false, reason: 'DAILY_LIMIT_REACHED', status: daily })),
    };
    const g = new AramoSignAllowanceGate(allowance as never, {} as never);
    await expect(g.guardSend('t', 'e', async () => 1)).rejects.toMatchObject({
      code: 'ESIGN_ALLOWANCE_EXHAUSTED',
      statusCode: 409,
      context: { details: { reason: 'DAILY_LIMIT_REACHED', window: 'DAY', limit: 2, used: 2, next_available_at: '2026-10-06T09:00:00.000Z' } },
    });
    allowance.reserve.mockResolvedValueOnce({ ok: false, reason: 'LIMIT_REACHED', status: { ...daily, used: 5 } } as never);
    await expect(g.guardSend('t', 'e', async () => 1)).rejects.toMatchObject({ context: { details: { reason: 'LIMIT_REACHED', limit: 5, used: 5, period_end: '2026-11-01T00:00:00.000Z' } } });
  });
});
