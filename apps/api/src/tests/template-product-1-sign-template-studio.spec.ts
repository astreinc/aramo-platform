import { describe, expect, it, vi } from 'vitest';

import { SignTemplateStudioService } from '../documents/sign-template-studio.service.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the Documents side
// of the Sign Studio and "Use as it is" (unit; the HTTP + Postgres proof is
// template-product-1-sign-studio-http.integration.spec.ts):
//   - authority from the person's LIVE grants (author / manage), never a token;
//   - the Studio is PERSONAL-only (BUSINESS 403 organization_templates_in_org_home);
//   - only live Aramo defaults tagged `sign` are offered or adoptable;
//   - "Use as it is" = the existing adopt → preview → activate of the tenant template code,
//     refused when already adopted, and the draft discarded if approval fails.

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const SIGN_DEFAULT = '33333333-3333-7333-8333-333333333333';
const ATS_DEFAULT = '33333333-3333-7333-8333-33333333aaaa';
const OWN = '44444444-4444-7444-8444-444444444444';

const item = (over: Record<string, unknown>) => ({
  id: SIGN_DEFAULT,
  owner_scope: 'PLATFORM',
  document_type_id: 'type-1',
  name: 'NDA',
  description: null,
  template_kind: 'GENERATED',
  status: 'ACTIVE',
  client_id: null,
  current_version_id: 'v-1',
  current_version_number: 1,
  updated_at: '2026-11-01T00:00:00.000Z',
  products: ['sign'],
  withdraw_effective_at: null,
  configurable: true,
  ...over,
});

function harness(opts: { kind?: string; held?: string[]; adoptedFrom?: string | null; activateFails?: boolean } = {}) {
  const library = {
    library: vi.fn(async () => ({
      items: [
        item({}),
        item({ id: ATS_DEFAULT, products: ['ats'] }),
        item({ id: '33333333-3333-7333-8333-33333333bbbb', configurable: false }),
        item({ id: OWN, owner_scope: 'TENANT', products: null, status: 'DRAFT', current_version_id: null }),
      ],
      document_types: [{ id: 'type-1', key: 'NDA', name: 'Non-disclosure agreement', configurable: true }],
    })),
    previewDefault: vi.fn(async () => ({ title: 'NDA' })),
  };
  const tenantTemplates = {
    adopt: vi.fn(async () => ({ template: { id: 'new-t' }, version: { id: 'new-v' } })),
    previewVersion: vi.fn(async () => ({ title: 'NDA' })),
    activate: vi.fn(async () => {
      if (opts.activateFails === true) throw new Error('binding unsupported');
      return { id: 'new-v', status: 'ACTIVE' };
    }),
    deleteDraft: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ id: OWN })),
    rename: vi.fn(async () => ({ id: OWN })),
    updateVersion: vi.fn(async () => ({ id: 'v' })),
    // TEMPLATE-SYNC-1 S-5 / S-7 / S-8.
    masterContent: vi.fn(async () => ({ version_number: 2 })),
    draftFromMaster: vi.fn(async () => ({ id: 'v-2' })),
    keepVersion: vi.fn(async () => ({ id: OWN })),
    // Sign Field-Test Batch 1 F15-1.
    listFields: vi.fn(async () => [{ field_key: 'sig_1', field_type: 'SIGNATURE', label: 'Employee signature', signer_role: 'Signer 1', required: true, ordinal: 0 }]),
  };
  const templates = {
    listTemplates: vi.fn(async () => [{ id: OWN, adopted_from_template_id: opts.adoptedFrom ?? null }]),
    getTemplate: vi.fn(async () => ({ id: 'new-t', status: 'ACTIVE', current_version_id: 'new-v' })),
  };
  const tenants = { findById: vi.fn(async () => ({ id: TENANT, kind: opts.kind ?? 'PERSONAL' })) };
  const roles = { getScopesByUserAndTenant: vi.fn(async () => opts.held ?? ['document_template:read', 'document_template:author', 'document_template:manage']) };
  const svc = new SignTemplateStudioService({
    templates: templates as never,
    tenantTemplates: tenantTemplates as never,
    library: library as never,
    tenants: tenants as never,
    roles: roles as never,
  });
  return { svc, library, tenantTemplates, templates, roles };
}

const who = { tenant_id: TENANT, actor_id: ACTOR, requestId: 'r' };

describe('§8.5 — the Sign gallery: live Aramo defaults tagged sign only', () => {
  it('lists only configurable, current, sign-tagged defaults, with the adopted copy', async () => {
    const h = harness({ adoptedFrom: SIGN_DEFAULT });
    const out = await h.svc.gallery({ tenant_id: TENANT, requestId: 'r' });
    expect(out.items).toEqual([
      {
        template_id: SIGN_DEFAULT,
        name: 'NDA',
        description: null,
        document_type: { id: 'type-1', name: 'Non-disclosure agreement' },
        products: ['sign'],
        version_id: 'v-1',
        version_number: 1,
        updated_at: '2026-11-01T00:00:00.000Z',
        adopted_template_id: OWN,
      },
    ]);
  });

  it('preview of a default not tagged sign is 404 (never offered to Sign)', async () => {
    const h = harness();
    await expect(h.svc.galleryPreview({ tenant_id: TENANT, template_id: ATS_DEFAULT, requestId: 'r' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', statusCode: 404 });
    expect(h.library.previewDefault).not.toHaveBeenCalled();
  });
});

describe('§8.5 — Use as it is', () => {
  it('an approver: adopt → record the sample preview → activate, as the person', async () => {
    const h = harness({ kind: 'BUSINESS', held: ['document_template:read', 'document_template:manage'] });
    const out = await h.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT });
    expect(out).toMatchObject({ template: { id: 'new-t', status: 'ACTIVE' }, version: { id: 'new-v', status: 'ACTIVE' } });
    const actor = vi.mocked(h.tenantTemplates.adopt).mock.calls[0]?.[0] as { sub: string; tenant_id: string };
    expect(actor).toMatchObject({ sub: ACTOR, tenant_id: TENANT });
    expect(h.tenantTemplates.adopt).toHaveBeenCalledWith(expect.anything(), { library_template_id: SIGN_DEFAULT }, 'r');
    expect(h.tenantTemplates.previewVersion).toHaveBeenCalledWith(expect.anything(), 'new-v', 'r');
    expect(h.tenantTemplates.activate).toHaveBeenCalledWith(expect.anything(), 'new-v', 'r');
  });

  it('without document_template:manage → 403 template_approval_required, nothing written', async () => {
    const h = harness({ kind: 'BUSINESS', held: ['document_template:read', 'document_template:author'] });
    await expect(h.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'template_approval_required' } },
    });
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  it('a default not tagged sign → 404; an already adopted one → 409 already_adopted', async () => {
    const h = harness();
    await expect(h.svc.adoptAndUse({ ...who, template_id: ATS_DEFAULT })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    const a = harness({ adoptedFrom: SIGN_DEFAULT });
    await expect(a.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT })).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'already_adopted', template_id: OWN } } });
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
    expect(a.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  // TP-6 × TP-8 — an Aramo fixed form tagged sign is never adoptable: its type is not configurable
  // (EDITABLE only), so it is not a Sign gallery default and "Use as it is" / adopt are 404 before
  // any adopt call (and the tenant adopt itself refuses fixed_form_not_adoptable). It is used as
  // it is from the Sign template list instead.
  it('an Aramo fixed form tagged sign (not configurable) → 404 on Use as it is and adopt, nothing adopted', async () => {
    const FIXED = '33333333-3333-7333-8333-33333333bbbb';
    const h = harness();
    await expect(h.svc.adoptAndUse({ ...who, template_id: FIXED })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', statusCode: 404 });
    await expect(h.svc.adopt({ ...who, library_template_id: FIXED })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', statusCode: 404 });
    expect((await h.svc.gallery({ tenant_id: TENANT, requestId: 'r' })).items.map((i) => i.template_id)).not.toContain(FIXED);
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  it('approval refused → the new draft is discarded (audited path) and the refusal stands', async () => {
    const h = harness({ activateFails: true });
    await expect(h.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT })).rejects.toThrow('binding unsupported');
    expect(h.tenantTemplates.deleteDraft).toHaveBeenCalledWith(expect.anything(), 'new-v', 'r');
  });
});

describe('§8.3 — the Studio: PERSONAL only, authority from live grants', () => {
  it('BUSINESS → 403 organization_templates_in_org_home on every Studio call', async () => {
    const h = harness({ kind: 'BUSINESS' });
    for (const call of [
      () => h.svc.studioList(who),
      () => h.svc.adopt({ ...who, library_template_id: SIGN_DEFAULT }),
      () => h.svc.get({ ...who, template_id: OWN }),
      () => h.svc.activate({ ...who, version_id: 'v' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'organization_templates_in_org_home' } } });
    }
    expect(h.roles.getScopesByUserAndTenant).not.toHaveBeenCalled();
  });

  it('edits need author, "Use this version" needs manage, reads need either', async () => {
    const reader = harness({ held: ['document_template:read'] });
    await expect(reader.svc.get({ ...who, template_id: OWN })).rejects.toMatchObject({ context: { details: { reason: 'template_authoring_required' } } });
    const author = harness({ held: ['document_template:read', 'document_template:author'] });
    await author.svc.rename({ ...who, template_id: OWN, name: 'Mine' });
    await expect(author.svc.activate({ ...who, version_id: 'v' })).rejects.toMatchObject({ context: { details: { reason: 'template_approval_required' } } });
  });

  it('the Studio list = own templates + sign-tagged defaults (ATS-only defaults hidden)', async () => {
    const h = harness();
    const out = await h.svc.studioList(who);
    expect(out.items.map((i) => i.id)).toEqual([SIGN_DEFAULT, OWN]);
  });

  it('adopt refuses a default not tagged sign before adopting', async () => {
    const h = harness();
    await expect(h.svc.adopt({ ...who, library_template_id: ATS_DEFAULT })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  it('only the editable version keys are forwarded', async () => {
    const h = harness();
    await h.svc.updateVersion({ ...who, version_id: 'v', body: { field_schema: { html: '' }, render_schema_version: 'rtr-html-v1' } });
    expect(h.tenantTemplates.updateVersion).toHaveBeenCalledWith(expect.anything(), 'v', { field_schema: { html: '' }, render_schema_version: 'rtr-html-v1' }, 'r');
  });
});

// TEMPLATE-SYNC-1 (Directive v1.0 LOCKED) S-5 / S-7 / S-8 — the Personal Studio's sync actions go
// through the SAME tenant template code as Org Home, as the person, with the same authority split.
describe('TEMPLATE-SYNC-1 — compare / start a draft from the new version / keep my version', () => {
  it('compare needs read, a draft needs author, keep needs manage; BUSINESS is refused', async () => {
    const h = harness();
    await h.svc.masterContent({ ...who, template_id: OWN });
    await h.svc.draftFromMaster({ ...who, template_id: OWN });
    await h.svc.keepVersion({ ...who, template_id: OWN });
    expect(h.tenantTemplates.masterContent).toHaveBeenCalledWith(expect.objectContaining({ sub: ACTOR, tenant_id: TENANT }), OWN, 'r');
    expect(h.tenantTemplates.draftFromMaster).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.arrayContaining(['document_template:author']) }), OWN, 'r');
    expect(h.tenantTemplates.keepVersion).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.arrayContaining(['document_template:manage']) }), OWN, 'r');

    const author = harness({ held: ['document_template:read', 'document_template:author'] });
    await expect(author.svc.keepVersion({ ...who, template_id: OWN })).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'template_approval_required' } } });
    expect(author.tenantTemplates.keepVersion).not.toHaveBeenCalled();
    const manager = harness({ held: ['document_template:read', 'document_template:manage'] });
    await expect(manager.svc.draftFromMaster({ ...who, template_id: OWN })).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'template_authoring_required' } } });
    const biz = harness({ kind: 'BUSINESS' });
    await expect(biz.svc.masterContent({ ...who, template_id: OWN })).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'organization_templates_in_org_home' } } });
  });
});

// Sign Field-Test Batch 1 (Directive v1.0 LOCKED) F15-1 — a version's field rows for the Personal
// Studio's locked chips: the SAME tenant read as Org Home, as the person (live grants, 'read').
describe('F15-1 — the version field rows (read)', () => {
  it('a reader with author or manage gets the bare array; a plain reader and BUSINESS are refused', async () => {
    const h = harness({ held: ['document_template:read', 'document_template:author'] });
    const rows = await h.svc.listFields({ ...who, version_id: 'v' });
    expect(rows).toEqual([{ field_key: 'sig_1', field_type: 'SIGNATURE', label: 'Employee signature', signer_role: 'Signer 1', required: true, ordinal: 0 }]);
    expect(h.tenantTemplates.listFields).toHaveBeenCalledWith(expect.objectContaining({ sub: ACTOR, tenant_id: TENANT }), 'v', 'r');
    const manager = harness({ held: ['document_template:read', 'document_template:manage'] });
    await manager.svc.listFields({ ...who, version_id: 'v' });
    expect(manager.tenantTemplates.listFields).toHaveBeenCalledTimes(1);

    const reader = harness({ held: ['document_template:read'] });
    await expect(reader.svc.listFields({ ...who, version_id: 'v' })).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'template_authoring_required' } } });
    const biz = harness({ kind: 'BUSINESS' });
    await expect(biz.svc.listFields({ ...who, version_id: 'v' })).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'organization_templates_in_org_home' } } });
    expect(reader.tenantTemplates.listFields).not.toHaveBeenCalled();
    expect(biz.tenantTemplates.listFields).not.toHaveBeenCalled();
  });
});
