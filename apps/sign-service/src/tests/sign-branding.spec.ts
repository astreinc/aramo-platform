import { AramoError } from '@aramo/common';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import { SigningSessionInvalidError, type SigningNotification } from '@aramo/sign';
import { describe, expect, it, vi } from 'vitest';

import { SignBrandingController } from '../app/branding/sign-branding.controller.js';
import { SignBrandingPublicController } from '../app/branding/sign-branding-public.controller.js';
import { SignBrandingService, emailLogoUrl } from '../app/branding/sign-branding.service.js';
import { MailerSigningNotificationAdapter, emailBrandingOf, renderEmail, renderSigningNotification } from '../app/mailer-signing-notification.adapter.js';
import { SIGN_BRANDING_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — Branding and customization:
// dark gating (R-8), the server-side plan entitlement, validation, the public signer routes,
// and the branded / unbranded notification email.

const T = '019000a0-0000-7000-8000-000000000001';
const RID = 'req-1';
const LOGO_ID = '019000a0-0000-4000-8000-0000000000aa';
const ADMIN = { tenant_id: T, sub: 'u-admin', scopes: ['sign:envelope:read', 'sign:settings:manage'] };
const READER = { tenant_id: T, sub: 'u-read', scopes: ['sign:envelope:read'] };

// A 1x1-header PNG claiming 64x32 (only the header is read).
function png(width = 64, height = 32): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

const STORED = {
  tenant_id: T,
  display_name: 'Acme Staffing',
  primary_color: '#0A7F3F',
  accent_color: '#FFB000',
  logo: { logo_id: LOGO_ID, content_type: 'image/png' as const, sha256: 'a'.repeat(64), byte_size: 40, width: 64, height: 32 },
  updated_at: new Date('2026-11-01T00:00:00Z'),
  updated_by: 'u-admin',
};

function repoFake(stored: typeof STORED | null = STORED) {
  return {
    get: vi.fn(async () => stored),
    setSettings: vi.fn(async (_t: string, input: { display_name: string | null; primary_color: string | null; accent_color: string | null }) => ({ ...STORED, ...input })),
    setLogo: vi.fn(async () => STORED),
    clearLogo: vi.fn(async () => ({ ...STORED, logo: null })),
    logoById: vi.fn(async (id: string) => (id === LOGO_ID ? { ...STORED.logo, tenant_id: T, bytes: png() } : null)),
    logoOfTenant: vi.fn(async () => ({ ...STORED.logo, tenant_id: T, bytes: png() })),
  };
}

function lifecycleFake(features: { feature_key: string; enabled: boolean }[] = [{ feature_key: SIGN_BRANDING_FEATURE, enabled: true }], over: Record<string, unknown> = {}) {
  return {
    account: vi.fn(async () => ({ subscription: { status: 'ACTIVE', ended_at: null, features, ...over } })),
  };
}

const ON = { ...FEATURE_AVAILABILITY, [SIGN_BRANDING_FEATURE]: 'AVAILABLE' as const };

function make(opts: { available?: boolean; entitled?: boolean; stored?: typeof STORED | null } = {}) {
  const repo = repoFake(opts.stored === undefined ? STORED : opts.stored);
  const lifecycle = lifecycleFake(opts.entitled === false ? [{ feature_key: SIGN_BRANDING_FEATURE, enabled: false }] : undefined);
  const gate = new SignFeatureGate(opts.available ? ON : undefined);
  const esign = { resolveSession: vi.fn(async () => ({ session_id: 's', tenant_id: T, envelope_id: 'e', signer_id: 'g' })) };
  const service = new SignBrandingService(repo as never, gate, lifecycle as never);
  const controller = new SignBrandingController(service, repo as never);
  const pub = new SignBrandingPublicController(service, esign as never);
  return { repo, lifecycle, esign, service, controller, pub };
}

async function refusal(p: Promise<unknown>): Promise<AramoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    return e as AramoError;
  }
  throw new Error('expected a refusal');
}

describe('sign.branding launch availability (R-8)', () => {
  it('ships NOT_AVAILABLE in the production registry', () => {
    expect(FEATURE_AVAILABILITY[SIGN_BRANDING_FEATURE]).toBe('NOT_AVAILABLE');
    expect(new SignBrandingService(repoFake() as never).available()).toBe(false);
  });
});

describe('SignBrandingController — dark', () => {
  it('every write answers 403 ESIGN_FEATURE_NOT_AVAILABLE feature_not_available and touches nothing', async () => {
    const { controller, repo, lifecycle } = make();
    const writes: Array<() => Promise<unknown>> = [
      () => controller.put(ADMIN as never, RID, { display_name: 'Acme' }),
      () => controller.putLogo(ADMIN as never, RID, { content_type: 'image/png', data_base64: Buffer.from(png()).toString('base64') }),
      () => controller.deleteLogo(ADMIN as never, RID),
    ];
    for (const w of writes) {
      const e = await refusal(w());
      expect(e.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
      expect(e.statusCode).toBe(403);
      expect(e.context.details).toEqual({ feature_key: 'sign.branding', reason: 'feature_not_available' });
    }
    for (const fn of [repo.setSettings, repo.setLogo, repo.clearLogo, repo.get, lifecycle.account]) expect(fn).not.toHaveBeenCalled();
  });

  it('GET reports not available with every value null, without reading the store', async () => {
    const { controller, repo } = make();
    expect(await controller.get(ADMIN as never)).toEqual({
      available: false,
      entitled: false,
      can_edit: false,
      display_name: null,
      primary_color: null,
      accent_color: null,
      logo: null,
      updated_at: null,
    });
    expect(repo.get).not.toHaveBeenCalled();
  });

  it('recipients get the default look: no signer branding, no logo, no certificate branding, no reads', async () => {
    const { pub, service, repo, esign } = make();
    expect(await pub.signerBranding({ token: 'tok' }, RID)).toEqual({ branding: null });
    expect(await service.certificateBranding(T)).toBeNull();
    const e = await refusal(pub.logo(LOGO_ID, RID, {} as never));
    expect(e.statusCode).toBe(404);
    for (const fn of [repo.get, repo.logoById, repo.logoOfTenant, esign.resolveSession]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('SignBrandingController — available, plan entitlement', () => {
  it('refuses writes with plan_not_entitled when the plan does not enable sign.branding', async () => {
    const { controller, repo } = make({ available: true, entitled: false });
    const e = await refusal(controller.put(ADMIN as never, RID, { display_name: 'Acme' }));
    expect(e.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    expect(e.context.details).toEqual({ feature_key: 'sign.branding', reason: 'plan_not_entitled' });
    expect(repo.setSettings).not.toHaveBeenCalled();
    const view = await controller.get(ADMIN as never);
    expect(view).toMatchObject({ available: true, entitled: false, can_edit: false });
  });

  it('is not entitled without a subscription, after it ended, or when it is canceled', async () => {
    const repo = repoFake();
    const gate = new SignFeatureGate(ON);
    expect(await new SignBrandingService(repo as never, gate).entitled(T)).toBe(false);
    const none = { account: vi.fn(async () => ({ subscription: null })) };
    expect(await new SignBrandingService(repo as never, gate, none as never).entitled(T)).toBe(false);
    const ended = lifecycleFake(undefined, { ended_at: new Date() });
    expect(await new SignBrandingService(repo as never, gate, ended as never).entitled(T)).toBe(false);
    const canceled = lifecycleFake(undefined, { status: 'CANCELED' });
    expect(await new SignBrandingService(repo as never, gate, canceled as never).entitled(T)).toBe(false);
    const broken = { account: vi.fn(async () => Promise.reject(new Error('db down'))) };
    expect(await new SignBrandingService(repo as never, gate, broken as never).entitled(T)).toBe(false);
  });

  it('GET: can_edit only with sign:settings:manage', async () => {
    const { controller } = make({ available: true });
    expect((await controller.get(ADMIN as never)).can_edit).toBe(true);
    const r = await controller.get(READER as never);
    expect(r).toMatchObject({ available: true, entitled: true, can_edit: false, display_name: 'Acme Staffing', primary_color: '#0A7F3F' });
    expect(r.logo).toEqual({ url: `/v1/sign/signing/brand-logo/${LOGO_ID}`, content_type: 'image/png', byte_size: 40, width: 64, height: 32 });
  });

  it('PUT normalises colours and the display name; empty values reset to the default', async () => {
    const { controller, repo } = make({ available: true });
    await controller.put(ADMIN as never, RID, { display_name: '  Acme   Staffing ', primary_color: '#0a7f3f', accent_color: '' });
    expect(repo.setSettings).toHaveBeenCalledWith(T, { display_name: 'Acme Staffing', primary_color: '#0A7F3F', accent_color: null }, 'u-admin');
    await controller.put(ADMIN as never, RID, {});
    expect(repo.setSettings).toHaveBeenLastCalledWith(T, { display_name: null, primary_color: null, accent_color: null }, 'u-admin');
  });

  it('PUT refuses invalid values with VALIDATION_ERROR naming the field', async () => {
    const { controller, repo } = make({ available: true });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ primary_color: 'red' }, 'invalid_primary_color'],
      [{ accent_color: '#12345' }, 'invalid_accent_color'],
      [{ display_name: 'x'.repeat(81) }, 'invalid_display_name'],
      [{ display_name: 'Ünïcode ✓ name' }, 'invalid_display_name'],
      [{ display_name: 42 }, 'invalid_display_name'],
    ];
    for (const [body, reason] of cases) {
      const e = await refusal(controller.put(ADMIN as never, RID, body));
      expect(e.code).toBe('VALIDATION_ERROR');
      expect((e.context.details as { reason: string }).reason).toBe(reason);
    }
    expect(repo.setSettings).not.toHaveBeenCalled();
  });

  it('logo upload: accepts a PNG whose bytes match the declared type', async () => {
    const { controller, repo } = make({ available: true });
    await controller.putLogo(ADMIN as never, RID, { content_type: 'image/png', data_base64: Buffer.from(png()).toString('base64') });
    expect(repo.setLogo).toHaveBeenCalledWith(T, png(), 'image/png', 'u-admin');
  });

  it('logo upload: refuses SVG, mismatched types, bad base64, oversize and out-of-range pixel sizes', async () => {
    const { controller, repo } = make({ available: true });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ content_type: 'image/svg+xml', data_base64: svg }, 'logo_type_unsupported'],
      [{ content_type: 'image/png', data_base64: svg }, 'logo_type_unsupported'],
      [{ content_type: 'image/jpeg', data_base64: Buffer.from(png()).toString('base64') }, 'logo_type_mismatch'],
      [{ content_type: 'image/png', data_base64: 'not base64!' }, 'logo_encoding_invalid'],
      [{ content_type: 'image/png', data_base64: '' }, 'logo_empty'],
      [{ content_type: 'image/png', data_base64: 'A'.repeat(349_532) }, 'logo_too_large'],
      [{ content_type: 'image/png', data_base64: Buffer.from(png(8, 8)).toString('base64') }, 'logo_dimensions_invalid'],
      [{ content_type: 'image/png', data_base64: Buffer.from(png(5000, 100)).toString('base64') }, 'logo_dimensions_invalid'],
    ];
    for (const [body, reason] of cases) {
      const e = await refusal(controller.putLogo(ADMIN as never, RID, body));
      expect(e.code).toBe('VALIDATION_ERROR');
      expect((e.context.details as { reason: string }).reason).toBe(reason);
    }
    expect(repo.setLogo).not.toHaveBeenCalled();
  });

  it('logo removal clears the logo', async () => {
    const { controller, repo } = make({ available: true });
    expect((await controller.deleteLogo(ADMIN as never, RID)).logo).toBeNull();
    expect(repo.clearLogo).toHaveBeenCalledWith(T, 'u-admin');
  });
});

describe('guest branding routes — available and entitled', () => {
  it('signer branding: the public view (no tenant id), from the signing token', async () => {
    const { pub, esign } = make({ available: true });
    const r = await pub.signerBranding({ token: 'tok' }, RID);
    expect(r).toEqual({ branding: { display_name: 'Acme Staffing', primary_color: '#0A7F3F', accent_color: '#FFB000', logo_url: `/v1/sign/signing/brand-logo/${LOGO_ID}` } });
    expect(JSON.stringify(r)).not.toContain(T);
    expect(esign.resolveSession).toHaveBeenCalledWith('tok');
  });

  it('signer branding: a token that no longer signs gets the default look; a missing token is a 400', async () => {
    const { pub, esign } = make({ available: true });
    esign.resolveSession.mockRejectedValueOnce(new SigningSessionInvalidError('unknown token'));
    expect(await pub.signerBranding({ token: 'gone' }, RID)).toEqual({ branding: null });
    expect((await refusal(pub.signerBranding({}, RID))).statusCode).toBe(400);
  });

  it('signer branding: null when the plan does not include branding, or nothing is stored', async () => {
    expect(await make({ available: true, entitled: false }).pub.signerBranding({ token: 'tok' }, RID)).toEqual({ branding: null });
    expect(await make({ available: true, stored: null }).pub.signerBranding({ token: 'tok' }, RID)).toEqual({ branding: null });
  });

  it('logo: served with a strict content type, nosniff and a sandboxing CSP', async () => {
    const { pub } = make({ available: true });
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v), status: vi.fn(() => res), end: vi.fn() };
    await pub.logo(LOGO_ID, RID, res as never);
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toBe("default-src 'none'");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('logo: 404 for an unknown or malformed id, or once the plan no longer includes branding', async () => {
    const { pub } = make({ available: true });
    expect((await refusal(pub.logo('019000a0-0000-4000-8000-0000000000bb', RID, {} as never))).statusCode).toBe(404);
    expect((await refusal(pub.logo('../../etc/passwd', RID, {} as never))).statusCode).toBe(404);
    expect((await refusal(make({ available: true, entitled: false }).pub.logo(LOGO_ID, RID, {} as never))).statusCode).toBe(404);
  });

  it('certificate branding: logo bytes, PDF format, display name and the primary colour', async () => {
    const { service } = make({ available: true });
    const b = await service.certificateBranding(T);
    expect(b).toMatchObject({ display_name: 'Acme Staffing', primary_color: '#0A7F3F', logo: { format: 'PNG', sha256: 'a'.repeat(64) } });
  });
});

describe('notification email branding', () => {
  const n: SigningNotification = {
    kind: 'SIGNATURE_REQUEST',
    to_email: 'jane@example.test',
    to_name: 'Jane',
    envelope_subject: 'Offer letter',
    tenant_id: T,
    signing_url: 'https://sign.aramo.ai/s/abcdefghijklmnopqrstuvwxyz',
  };

  it('without branding the email is unchanged (default Aramo Sign sign-off, unstyled link)', () => {
    const r = renderSigningNotification(n);
    const { html, text } = renderEmail(n, r, null);
    expect(html).toContain('<a href="https://sign.aramo.ai/s/abcdefghijklmnopqrstuvwxyz">Review &amp; sign</a>');
    expect(html).toContain('— Aramo Sign</p>');
    expect(html).not.toContain('<img');
    expect(text.endsWith('— Aramo Sign')).toBe(true);
  });

  it('with branding: the logo, the coloured button with readable text, and "<name> via Aramo Sign"', () => {
    const r = renderSigningNotification(n);
    const brand = emailBrandingOf(
      { display_name: 'Acme <Staffing>', primary_color: '#FFEE00', accent_color: null, logo: { logo_id: LOGO_ID, content_type: 'image/png', sha256: 'a', width: 1, height: 1 } },
      { ARAMO_SIGN_BASE_URL: 'https://sign.aramo.ai' } as NodeJS.ProcessEnv,
    );
    const { html, text } = renderEmail(n, r, brand);
    expect(html).toContain(`<img src="https://sign.aramo.ai/v1/sign/signing/brand-logo/${LOGO_ID}" alt="Acme &lt;Staffing&gt;"`);
    expect(html).toContain('background:#FFEE00;color:#000000');
    expect(html).toContain('— Acme &lt;Staffing&gt; via Aramo Sign</p>');
    expect(text.endsWith('— Acme <Staffing> via Aramo Sign')).toBe(true);
  });

  it('no logo address without a configured Sign origin', () => {
    expect(emailLogoUrl({ display_name: null, primary_color: null, accent_color: null, logo: { logo_id: LOGO_ID, content_type: 'image/png', sha256: 'a', width: 1, height: 1 } }, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('the adapter reads no branding while the feature is dark, and never fails a send on a branding error', async () => {
    const mailer = { send: vi.fn(async () => ({ message_id: 'm1' })) };
    const dark = make();
    await new MailerSigningNotificationAdapter(mailer as never, dark.service).notify(n);
    expect(dark.repo.get).not.toHaveBeenCalled();
    expect((mailer.send.mock.calls[0] as unknown as [{ html: string }])[0].html).toContain('— Aramo Sign</p>');

    const on = make({ available: true });
    on.repo.get.mockRejectedValueOnce(new Error('db down'));
    await expect(new MailerSigningNotificationAdapter(mailer as never, on.service).notify(n)).resolves.toEqual({ delivered: true, provider_message_id: 'm1' });
  });
});
