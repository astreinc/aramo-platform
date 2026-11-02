import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { FEATURE_AVAILABILITY, type SignTemplateEntitlement } from '@aramo/subscription';
import { ESIGN_S2S_SIGNATURE_HEADER, ESIGN_S2S_TIMESTAMP_HEADER, signTemplateBodyDigest, verifyEsignServiceRequest } from '@aramo/documents-contracts';

import { DocumentTemplateStudioHttpAdapter, type DocumentTemplateStudioPort } from '../app/document-template-studio-http.adapter.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderTemplateStudioService } from '../app/sender/sender-template-studio.service.js';
import { SenderTemplatesService } from '../app/sender/sender-templates.service.js';
import { templateAuthority, templatePlanOf } from '../app/sender/template-authority.js';
import { EsignSenderTemplateStudioController } from '../app/sender/esign-sender-template-studio.controller.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.1–8.3 / §8.5 — sign-service:
//   - every Studio / gallery / "Use as it is" route passes the SAME template gate as the use
//     routes (launch availability → document_template:read → the plan; P-6: never Free) BEFORE
//     any Documents call;
//   - the Studio is PERSONAL-only (BUSINESS 403 organization_templates_in_org_home, no call);
//   - Sign stores nothing: every call is a signed S2S call carrying tenant_id + actor_id;
//   - the Personal letterhead is the person's name (personalWorkspaceLabel), never a logo;
//   - the sender context reports template_plan / template_studio / template_use_as_is.

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';
const TEMPLATE = '33333333-3333-7333-8333-333333333333';
const VERSION = '44444444-4444-7444-8444-444444444444';
const AVAILABLE = { [SIGN_TEMPLATES_FEATURE]: 'AVAILABLE' as const };
const DARK = { ...FEATURE_AVAILABILITY, 'sign.templates': 'NOT_AVAILABLE' as const };

function auth(scopes: string[] = ['sign:envelope:read', 'document_template:read']): AuthContextType {
  return { sub: USER, tenant_id: TENANT, scopes, consumer_type: 'sign', actor_kind: 'user', iat: 0, exp: 0 };
}

function harness(opts: { kind?: string; registry?: Record<string, 'AVAILABLE' | 'NOT_AVAILABLE'>; plan?: SignTemplateEntitlement; answer?: unknown } = {}) {
  const port: DocumentTemplateStudioPort = { call: vi.fn(async () => (opts.answer ?? {}) as never) };
  const entitlements = { of: vi.fn(async (): Promise<SignTemplateEntitlement> => opts.plan ?? { kind: 'INCLUDED', plan_key: 'aramo-sign-standard-personal-v1' }) };
  const templates = new SenderTemplatesService({} as never, new SignFeatureGate(opts.registry ?? AVAILABLE), {} as never, {} as never, {} as never, entitlements as never);
  const context = { tenantKind: vi.fn(async () => opts.kind ?? 'PERSONAL') };
  const identity = { findUserById: vi.fn(async () => ({ id: USER, display_name: 'Pat Lee', email: 'pat@gmail.com' })) };
  const svc = new SenderTemplateStudioService(port, templates, context as never, identity as never);
  return { svc, port, entitlements };
}

describe('§8 — the template gate comes first (never a Documents call when refused)', () => {
  it('sign.templates NOT_AVAILABLE → ESIGN_FEATURE_NOT_AVAILABLE on gallery, Use as it is and the Studio', async () => {
    const h = harness({ registry: DARK });
    for (const call of [() => h.svc.gallery(auth(), 'r'), () => h.svc.adoptAndUse(auth(), TEMPLATE, 'r'), () => h.svc.list(auth(), 'r'), () => h.svc.activate(auth(), VERSION, 'r')]) {
      await expect(call()).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', statusCode: 403 });
    }
    expect(h.port.call).not.toHaveBeenCalled();
  });

  it('P-6 — the Free plan is refused (templates_not_in_plan) on every route', async () => {
    const h = harness({ plan: { kind: 'NONE', plan_key: 'aramo-sign-free-personal-v1', reason: 'free_plan' } });
    for (const call of [() => h.svc.gallery(auth(), 'r'), () => h.svc.adoptAndUse(auth(), TEMPLATE, 'r'), () => h.svc.list(auth(), 'r'), () => h.svc.adopt(auth(), { library_template_id: TEMPLATE }, 'r')]) {
      await expect(call()).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', context: { details: { reason: 'templates_not_in_plan' } } });
    }
    expect(h.port.call).not.toHaveBeenCalled();
  });

  it('the session must hold document_template:read', async () => {
    const h = harness();
    await expect(h.svc.gallery(auth(['sign:envelope:read']), 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(h.port.call).not.toHaveBeenCalled();
  });
});

describe('§8.3 — the Studio is PERSONAL-only; Sign stores nothing', () => {
  it('BUSINESS → 403 organization_templates_in_org_home, no Documents call', async () => {
    const h = harness({ kind: 'BUSINESS' });
    for (const call of [
      () => h.svc.list(auth(), 'r'),
      () => h.svc.adopt(auth(), { library_template_id: TEMPLATE }, 'r'),
      () => h.svc.get(auth(), TEMPLATE, 'r'),
      () => h.svc.updateVersion(auth(), VERSION, { field_schema: {} }, 'r'),
      () => h.svc.activate(auth(), VERSION, 'r'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403, context: { details: { reason: 'organization_templates_in_org_home' } } });
    }
    expect(h.port.call).not.toHaveBeenCalled();
  });

  it('PERSONAL → each Studio call is one signed S2S call with tenant_id + actor_id', async () => {
    const h = harness();
    await h.svc.list(auth(), 'r');
    await h.svc.adopt(auth(), { library_template_id: TEMPLATE, extra: 'ignored' }, 'r');
    await h.svc.rename(auth(), TEMPLATE, { name: 'Mine' }, 'r');
    await h.svc.createVersion(auth(), TEMPLATE, { render_schema_version: 'rtr-html-v1', field_schema: { html: '' } }, 'r');
    await h.svc.createDraft(auth(), TEMPLATE, 'r');
    await h.svc.updateVersion(auth(), VERSION, { field_schema: { html: '<p>x</p>' }, status: 'ACTIVE' }, 'r');
    await h.svc.discardDraft(auth(), VERSION, 'r');
    await h.svc.preview(auth(), VERSION, 'r');
    await h.svc.activate(auth(), VERSION, 'r');
    const calls = vi.mocked(h.port.call).mock.calls.map(([c]) => ({ method: c.method, path: c.path, query: c.query, body: c.body }));
    const who = { tenant_id: TENANT, actor_id: USER };
    expect(calls).toEqual([
      { method: 'GET', path: '/studio', query: who, body: undefined },
      { method: 'POST', path: '/studio/adopt', query: who, body: { library_template_id: TEMPLATE } },
      { method: 'PATCH', path: `/studio/${TEMPLATE}`, query: who, body: { name: 'Mine' } },
      { method: 'POST', path: `/studio/${TEMPLATE}/versions`, query: who, body: { render_schema_version: 'rtr-html-v1', field_schema: { html: '' } } },
      { method: 'POST', path: `/studio/${TEMPLATE}/draft`, query: who, body: {} },
      // Only the editable keys are forwarded (status is never accepted).
      { method: 'PATCH', path: `/studio/versions/${VERSION}`, query: who, body: { field_schema: { html: '<p>x</p>' } } },
      { method: 'DELETE', path: `/studio/versions/${VERSION}`, query: who, body: undefined },
      { method: 'POST', path: `/studio/versions/${VERSION}/preview`, query: who, body: {} },
      { method: 'POST', path: `/studio/versions/${VERSION}/activate`, query: who, body: {} },
    ]);
  });

  it('a malformed id is refused before any call', async () => {
    const h = harness();
    await expect(h.svc.get(auth(), 'not-a-uuid', 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    await expect(h.svc.adopt(auth(), {}, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.port.call).not.toHaveBeenCalled();
  });

  it('§8.2 — the letterhead is the person’s name; a Personal account captures no logo', async () => {
    const h = harness({ answer: { bindings: [{ key: 'organization.name' }], tenant_logo: { available: true, tenant_name: 'Pat Lee (Personal 88df9551)' } } });
    const out = await h.svc.allowedBindings(auth(), TEMPLATE, 'r');
    expect(out).toEqual({ bindings: [{ key: 'organization.name' }], tenant_logo: { available: false, tenant_name: 'Pat Lee — Personal' } });
  });
});

describe('§8.5 — the gallery and "Use as it is" (every tenant kind)', () => {
  it('gallery: one GET /library for the tenant (no actor needed)', async () => {
    const h = harness({ kind: 'BUSINESS', answer: { items: [] } });
    await h.svc.gallery(auth(), 'r');
    expect(vi.mocked(h.port.call).mock.calls[0]?.[0]).toMatchObject({ method: 'GET', path: '/library', query: { tenant_id: TENANT } });
  });

  it('Use as it is: one POST adopt-and-use carrying the person (BUSINESS allowed; apps/api checks the grant)', async () => {
    const h = harness({ kind: 'BUSINESS' });
    await h.svc.adoptAndUse(auth(), TEMPLATE, 'r');
    expect(vi.mocked(h.port.call).mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: `/library/${TEMPLATE}/adopt-and-use`,
      query: { tenant_id: TENANT, actor_id: USER },
      body: {},
    });
  });

  it('gallery preview: PERSONAL letterhead = the person’s name; BUSINESS unchanged', async () => {
    const answer = { title: 'NDA', letterhead: { organization_name: 'Stored handle', logo_available: false } };
    const p = harness({ answer });
    expect(await p.svc.galleryPreview(auth(), TEMPLATE, 'r')).toMatchObject({ letterhead: { organization_name: 'Pat Lee — Personal' } });
    const b = harness({ kind: 'BUSINESS', answer });
    expect(await b.svc.galleryPreview(auth(), TEMPLATE, 'r')).toMatchObject({ letterhead: { organization_name: 'Stored handle' } });
  });

  it('the controller exposes exactly the §8 routes', () => {
    const own = Object.getOwnPropertyNames(EsignSenderTemplateStudioController.prototype).filter((n) => n !== 'constructor' && n !== 'run');
    expect(own.sort()).toEqual(
      ['gallery', 'galleryPreview', 'adoptAndUse', 'list', 'adopt', 'get', 'rename', 'versions', 'createVersion', 'createDraft', 'allowedBindings', 'updateVersion', 'discardDraft', 'preview', 'activate'].sort(),
    );
  });
});

describe('§8.1 / §8.5 — the sender context reports the template plan and authority', () => {
  it('templatePlanOf maps the plan reader (P-6: Free is FREE_PLAN)', () => {
    expect(templatePlanOf({ kind: 'INCLUDED', plan_key: 'p' })).toBe('INCLUDED');
    expect(templatePlanOf({ kind: 'NOT_SUBSCRIBED' })).toBe('NOT_SUBSCRIBED');
    expect(templatePlanOf({ kind: 'NONE', plan_key: 'p', reason: 'free_plan' })).toBe('FREE_PLAN');
    expect(templatePlanOf({ kind: 'NONE', plan_key: 'p', reason: 'subscription_inactive' })).toBe('SUBSCRIPTION_INACTIVE');
  });

  it('templateAuthority: the Studio only for PERSONAL; Use as it is needs document_template:manage', () => {
    expect(templateAuthority('PERSONAL', { author: true, manage: true })).toEqual({ studio: true, use_as_is: true });
    expect(templateAuthority('BUSINESS', { author: true, manage: true })).toEqual({ studio: false, use_as_is: true });
    expect(templateAuthority('BUSINESS', { author: true, manage: false })).toEqual({ studio: false, use_as_is: false });
    expect(templateAuthority('PERSONAL', { author: false, manage: false })).toEqual({ studio: false, use_as_is: false });
  });

  function contextService(kind: string, plan: SignTemplateEntitlement, held: string[], registry: Record<string, 'AVAILABLE' | 'NOT_AVAILABLE'> = AVAILABLE) {
    const tenants = {
      findById: vi.fn(async () => ({ id: TENANT, name: 'x', kind, is_active: true, status: 'ACTIVE' })),
      findSlugById: vi.fn(async () => null),
      findOrganizationNameById: vi.fn(async () => 'Org'),
    };
    const identity = {
      findUserById: vi.fn(async () => ({ id: USER, email: 'pat@gmail.com', display_name: 'Pat Lee' })),
      findMembership: vi.fn(async () => ({ id: 'm1', is_active: true })),
      findRoleKeysForMembership: vi.fn(async () => ['tenant_owner']),
    };
    const roles = { getScopesByUserAndTenant: vi.fn(async () => held) };
    const plans = { of: vi.fn(async () => plan) };
    return new SenderContextService(tenants as never, identity as never, new SignFeatureGate(registry), undefined, undefined, undefined, plans as never, roles as never);
  }

  it('PERSONAL owner on Personal Standard → Studio + Use as it is', async () => {
    const view = await contextService('PERSONAL', { kind: 'INCLUDED', plan_key: 'aramo-sign-standard-personal-v1' }, ['document_template:author', 'document_template:manage']).context(auth(), 'r');
    expect(view).toMatchObject({ template_plan: 'INCLUDED', template_studio: true, template_use_as_is: true });
  });

  it('PERSONAL on the Free plan → FREE_PLAN, nothing offered (P-6)', async () => {
    const view = await contextService('PERSONAL', { kind: 'NONE', plan_key: 'aramo-sign-free-personal-v1', reason: 'free_plan' }, ['document_template:author', 'document_template:manage']).context(auth(), 'r');
    expect(view).toMatchObject({ template_plan: 'FREE_PLAN', template_studio: false, template_use_as_is: false });
  });

  it('BUSINESS tenant_admin → no Studio in Sign (Org Home), Use as it is offered', async () => {
    const view = await contextService('BUSINESS', { kind: 'INCLUDED', plan_key: 'b' }, ['document_template:author', 'document_template:manage']).context(auth(), 'r');
    expect(view).toMatchObject({ template_plan: 'INCLUDED', template_studio: false, template_use_as_is: true });
  });

  it('BUSINESS sender without approval → no Use as it is', async () => {
    const view = await contextService('BUSINESS', { kind: 'INCLUDED', plan_key: 'b' }, ['document_template:read']).context(auth(), 'r');
    expect(view).toMatchObject({ template_studio: false, template_use_as_is: false });
  });

  it('sign.templates NOT_AVAILABLE → nothing read, nothing offered', async () => {
    const view = await contextService('PERSONAL', { kind: 'INCLUDED', plan_key: 'p' }, ['document_template:manage'], DARK).context(auth(), 'r');
    expect(view).toMatchObject({ template_plan: null, template_studio: false, template_use_as_is: false });
  });
});

describe('DocumentTemplateStudioHttpAdapter — signed S2S, body digest, refusals', () => {
  const SECRET = 'tp7-adapter-secret';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    else process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = saved;
    vi.unstubAllGlobals();
  });

  it('signs the exact request and binds the body digest', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { library_template_id: TEMPLATE };
    await new DocumentTemplateStudioHttpAdapter().call({ method: 'POST', path: '/studio/adopt', query: { tenant_id: TENANT, actor_id: USER }, body, requestId: 'r' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    const u = new URL(url);
    expect(u.pathname).toBe('/v1/documents/esign/templates/studio/adopt');
    expect(u.searchParams.get('body_sha256')).toBe(signTemplateBodyDigest(body));
    expect(u.searchParams.get('actor_id')).toBe(USER);
    const verdict = verifyEsignServiceRequest({
      method: 'POST',
      path: u.pathname,
      rawQuery: u.search.slice(1),
      timestampHeader: init.headers[ESIGN_S2S_TIMESTAMP_HEADER],
      signatureHeader: init.headers[ESIGN_S2S_SIGNATURE_HEADER],
      secret: SECRET,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(verdict.ok).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it('GET / DELETE carry no body and no digest; 204 → undefined', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await new DocumentTemplateStudioHttpAdapter().call({ method: 'DELETE', path: `/studio/versions/${VERSION}`, query: { tenant_id: TENANT, actor_id: USER }, requestId: 'r' });
    expect(out).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has('body_sha256')).toBe(false);
    expect(init.body).toBeUndefined();
  });

  it('passes the person-level 403 through; any other 401/403 is a 502 (a refusal of sign-service itself)', async () => {
    const answer = (status: number, details: Record<string, unknown>) =>
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'no', details } }), { status }));
    vi.stubGlobal('fetch', answer(403, { reason: 'template_approval_required' }));
    await expect(new DocumentTemplateStudioHttpAdapter().call({ method: 'GET', path: '/studio', query: { tenant_id: TENANT }, requestId: 'r' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'template_approval_required' } },
    });
    vi.stubGlobal('fetch', answer(403, { reason: 'something_else' }));
    await expect(new DocumentTemplateStudioHttpAdapter().call({ method: 'GET', path: '/studio', query: { tenant_id: TENANT }, requestId: 'r' })).rejects.toMatchObject({ statusCode: 502 });
    vi.stubGlobal('fetch', answer(401, {}));
    await expect(new DocumentTemplateStudioHttpAdapter().call({ method: 'GET', path: '/studio', query: { tenant_id: TENANT }, requestId: 'r' })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('fails closed without the secret (no request sent)', async () => {
    delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DocumentTemplateStudioHttpAdapter().call({ method: 'GET', path: '/library', query: { tenant_id: TENANT }, requestId: 'r' })).rejects.toMatchObject({
      code: 'ESIGN_SERVICE_AUTH_UNAVAILABLE',
      statusCode: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
