import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { DocumentTemplatesController } from '../lib/templates.controller.js';
import { TemplateDraftAlreadyExistsError, TemplateNotFoundError } from '../lib/domain/errors.js';
import { templateMasterView, type TemplateMasterRow, type TemplateMasterView } from '../lib/template-master.js';
import type { TemplateAuditPort } from '../lib/template-audit.port.js';
import type { TemplateCapabilitiesPort, TemplateLogoRef } from '../lib/template-capabilities.port.js';
import type { TemplatesRepository } from '../lib/templates.repository.js';

// TEMPLATE-SYNC-1 (Directive v1.0 LOCKED) S-3, S-5, S-7, S-8 and §3.6 — the tenant routes over a
// fake repository (the real-Postgres route tests are apps/api template-sync-1.integration.spec.ts).

const TENANT = '11111111-1111-4111-8111-111111111111';
const AUTH = { sub: 'user-1', tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;
const RID = 'req-1';
const NOW_MASTER: TemplateMasterRow = { id: 'master-1', name: 'Mutual NDA', status: 'ACTIVE', current_version_id: 'mv2', withdraw_notice_at: null, withdraw_effective_at: null };
const LOGO: TemplateLogoRef = { asset_id: 'asset-1', sha256: 'a'.repeat(64), mime: 'image/png' };

function copy(over: Record<string, unknown> = {}) {
  return { id: 'copy-1', tenant_id: TENANT, owner_scope: 'TENANT', document_type_id: 'type-1', name: 'Our NDA', adopted_from_template_id: 'master-1', adopted_from_version_id: 'mv1', current_version_id: 'cv1', ...over };
}

function setup(opts: { template?: Record<string, unknown>; master?: TemplateMasterRow | null; view?: Partial<TemplateMasterView> | null; draftExists?: boolean } = {}) {
  const template = opts.template ?? copy();
  const master = opts.master === undefined ? NOW_MASTER : opts.master;
  const v = opts.view === null ? null : { ...templateMasterView({ master_template_id: 'master-1', master, master_current_version_number: 2, based_on_version_number: 1, kept_version_id: null, now: new Date() }), ...(opts.view ?? {}) };
  const repo = {
    getTemplate: vi.fn(async (_t: string, id: string) => {
      if (id !== template.id) throw new TemplateNotFoundError(id);
      return template;
    }),
    listTemplates: vi.fn(async () => [template, copy({ id: 'own-2', adopted_from_template_id: null, adopted_from_version_id: null })]),
    adoptedCopyWithMaster: vi.fn(async (_t: string, id: string) => {
      if (id !== template.id) throw new TemplateNotFoundError(id);
      return { template, master };
    }),
    masterViewsForTenant: vi.fn(async () => new Map(v !== null && template['adopted_from_template_id'] !== null ? [[template.id as string, v]] : [])),
    getPlatformVersion: vi.fn(async () => ({
      id: 'mv2',
      version_number: 2,
      render_schema_version: 'rtr-html-v2',
      field_schema: { render_schema_version: 'rtr-html-v2', title: 'Mutual NDA', html: '<p>Master wording</p>', signing: { roles: [{ key: 'a' }] } },
    })),
    getVersion: vi.fn(async () => ({
      id: 'cv1',
      field_schema: { render_schema_version: 'rtr-html-v2', title: 'Our NDA', html: '<div data-asset="tenant.logo"></div><p>Our wording</p>', logo: LOGO, signing: { roles: [{ key: 'ours' }] } },
      internal_notes: 'ours',
    })),
    createDraftFromPlatformVersion: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.draftExists === true) throw new TemplateDraftAlreadyExistsError(template.id as string, 'draft-9');
      return { version: { id: 'cv2', version_number: 2, template_id: template.id, field_schema: input['field_schema'] }, source: {} };
    }),
    keepPlatformVersion: vi.fn(async () => ({ ...template, sync_kept_platform_version_id: 'mv2' })),
    // TEMPLATE-FIELDS-1 — the master version's field rows (none unless a test sets them).
    listPlatformFields: vi.fn(async (_id: string): Promise<unknown[]> => []),
  };
  const caps = {
    isConfigurable: vi.fn(async () => true),
    draftContentFrom: vi.fn((c: { render_schema_version: string; field_schema: unknown }) => c),
    normalizeDraftContent: vi.fn(async (i: { field_schema: unknown; render_schema_version: string; existing_field_schema: unknown }) => {
      const o = i.field_schema as Record<string, unknown>;
      return { render_schema_version: i.render_schema_version, title: o['title'], html: o['html'], logo: null, ...(o['signing'] !== null ? { signing: o['signing'] } : {}) };
    }),
    logoOf: vi.fn((fs: unknown) => ((fs as Record<string, unknown> | null)?.['logo'] as TemplateLogoRef | undefined) ?? null),
    withLogo: vi.fn((fs: unknown, logo: TemplateLogoRef | null) => ({ ...(fs as Record<string, unknown>), html: `<div data-asset="tenant.logo"></div>${(fs as Record<string, string>)['html']}`, logo })),
  } as unknown as TemplateCapabilitiesPort;
  const audit = { recordGovernance: vi.fn(async () => undefined) } as unknown as TemplateAuditPort;
  const c = new DocumentTemplatesController(repo as unknown as TemplatesRepository, caps, audit);
  return { c, repo, caps, audit };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; status: number; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code: string; statusCode: number; context?: { details?: { reason?: unknown } } };
    return { code: err.code, status: err.statusCode, reason: err.context?.details?.reason };
  }
  throw new Error('expected a refusal');
}

describe('TEMPLATE-SYNC-1 S-3 — the master object on the tenant template reads', () => {
  it('GET list: adopted copies carry master, a template written by the company carries null', async () => {
    const { c } = setup();
    const rows = (await c.list(AUTH)) as Array<{ id: string; master: TemplateMasterView | null }>;
    expect(rows.find((r) => r.id === 'copy-1')?.master?.newer_available).toBe(true);
    expect(rows.find((r) => r.id === 'own-2')?.master).toBeNull();
  });

  it('GET :id: not adopted ⇒ master null', async () => {
    const { c } = setup({ template: copy({ adopted_from_template_id: null, adopted_from_version_id: null }) });
    const t = (await c.get(AUTH, 'copy-1', RID)) as { master: unknown };
    expect(t.master).toBeNull();
  });
});

describe('TEMPLATE-SYNC-1 S-5 — compare content route', () => {
  it("returns the master's CURRENT version stored content", async () => {
    const { c, repo } = setup();
    const out = await c.masterContent(AUTH, 'copy-1', RID);
    expect(repo.getPlatformVersion).toHaveBeenCalledWith('mv2');
    expect(out).toMatchObject({ template_id: 'copy-1', master_template_id: 'master-1', version_id: 'mv2', version_number: 2, render_schema_version: 'rtr-html-v2', title: 'Mutual NDA', html: '<p>Master wording</p>', signing: { roles: [{ key: 'a' }] } });
  });

  it('404 for a template the company wrote itself (not_an_adopted_template) and for a deleted master', async () => {
    expect(await refusal(setup({ template: copy({ adopted_from_template_id: null }) }).c.masterContent(AUTH, 'copy-1', RID))).toMatchObject({ code: 'TEMPLATE_NOT_FOUND', reason: 'not_an_adopted_template' });
    expect(await refusal(setup({ master: null }).c.masterContent(AUTH, 'copy-1', RID))).toMatchObject({ code: 'TEMPLATE_NOT_FOUND', reason: 'master_not_available' });
    expect(await refusal(setup().c.masterContent(AUTH, 'other', RID))).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('TEMPLATE-SYNC-1 S-7 — start a draft from the new version', () => {
  it("master content + master roles, the company's logo carried over, based on the master version, audited", async () => {
    const { c, repo, caps, audit } = setup();
    const out = (await c.draftFromMaster(AUTH, 'copy-1', RID)) as { id: string; logo: unknown };
    const call = repo.createDraftFromPlatformVersion.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({ tenant_id: TENANT, template_id: 'copy-1', platform_version_id: 'mv2', render_schema_version: 'rtr-html-v2', internal_notes: 'ours', created_by: 'user-1' });
    const fs = call['field_schema'] as Record<string, unknown>;
    expect(fs['html']).toBe('<div data-asset="tenant.logo"></div><p>Master wording</p>');
    expect(fs['logo']).toEqual(LOGO);
    expect(fs['signing']).toEqual({ roles: [{ key: 'a' }] });
    // Normalised with no existing content: nothing of the copy's wording or roles mixed in.
    expect((caps.normalizeDraftContent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ existing_field_schema: null });
    expect(out.id).toBe('cv2');
    expect(audit.recordGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'draft_from_master', tenant_id: TENANT, subject_id: 'copy-1', payload: expect.objectContaining({ version_id: 'cv2', master_version_id: 'mv2', master_version_number: 2 }) }),
    );
  });

  // TEMPLATE-FIELDS-1 F-3 × SYNC-1 S-7 — a master with fields in its text: the normaliser checks
  // the master's markers against the master version's own rows (the rows the draft copies), so
  // the update is not refused as field_marker_mismatch.
  it("a master with inline fields is normalised with the master version's own field rows", async () => {
    const { c, repo, caps } = setup();
    repo.listPlatformFields.mockResolvedValueOnce([
      { field_key: 'nda_accepted', field_type: 'CHECKBOX', signer_role: 'party', required: false, ordinal: 0, label: 'Accepted', page_number: null, x: null, y: null, width: null, height: null },
    ]);
    await c.draftFromMaster(AUTH, 'copy-1', RID);
    expect(repo.listPlatformFields).toHaveBeenCalledWith('mv2');
    const arg = (caps.normalizeDraftContent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { fields: Array<{ field_key: string }>; owner: string };
    expect(arg.fields.map((f) => f.field_key)).toEqual(['nda_accepted']);
    expect(arg.owner).toBe('TENANT');
  });

  it('a master without signing roles gives a draft without roles (roles come from the master)', async () => {
    const { c, repo, caps } = setup();
    repo.getPlatformVersion.mockResolvedValueOnce({ id: 'mv2', version_number: 2, render_schema_version: 'rtr-html-v2', field_schema: { render_schema_version: 'rtr-html-v2', title: 'T', html: '<p>x</p>' } } as never);
    await c.draftFromMaster(AUTH, 'copy-1', RID);
    expect(((caps.normalizeDraftContent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { field_schema: Record<string, unknown> }).field_schema['signing']).toBeNull();
  });

  it('§3.6 refusals: not_an_adopted_template, master_not_available, already_current, draft_exists', async () => {
    expect(await refusal(setup({ template: copy({ adopted_from_template_id: null }) }).c.draftFromMaster(AUTH, 'copy-1', RID))).toMatchObject({ status: 404, reason: 'not_an_adopted_template' });
    expect(await refusal(setup({ master: null }).c.draftFromMaster(AUTH, 'copy-1', RID))).toMatchObject({ status: 409, reason: 'master_not_available' });
    const withdrawn = { ...NOW_MASTER, withdraw_notice_at: new Date('2026-01-01'), withdraw_effective_at: new Date('2026-02-01') };
    expect(await refusal(setup({ master: withdrawn }).c.draftFromMaster(AUTH, 'copy-1', RID))).toMatchObject({ status: 409, reason: 'master_not_available' });
    expect(await refusal(setup({ view: { current_version_number: 2, based_on_version_number: 2 } }).c.draftFromMaster(AUTH, 'copy-1', RID))).toMatchObject({ code: 'VALIDATION_ERROR', status: 409, reason: 'already_current' });
    expect(await refusal(setup({ draftExists: true }).c.draftFromMaster(AUTH, 'copy-1', RID))).toMatchObject({ code: 'TEMPLATE_DRAFT_ALREADY_EXISTS', status: 409, reason: 'draft_exists' });
  });

  it('kept for this master version: a draft may still be started (the company changed its mind)', async () => {
    const { c, repo } = setup({ view: { kept: true, newer_available: false } });
    await c.draftFromMaster(AUTH, 'copy-1', RID);
    expect(repo.createDraftFromPlatformVersion).toHaveBeenCalled();
  });
});

describe('TEMPLATE-SYNC-1 S-8 — keep my version', () => {
  it("records the master's current version, audited", async () => {
    const { c, repo, audit } = setup();
    await c.keepVersion(AUTH, 'copy-1', RID);
    expect(repo.keepPlatformVersion).toHaveBeenCalledWith({ tenant_id: TENANT, template_id: 'copy-1', platform_version_id: 'mv2' });
    expect(audit.recordGovernance).toHaveBeenCalledWith(expect.objectContaining({ action: 'master_version_kept', subject_id: 'copy-1', payload: expect.objectContaining({ master_version_id: 'mv2', master_version_number: 2 }) }));
  });

  it('refused already_current when no newer version exists; not_an_adopted_template; master_not_available', async () => {
    expect(await refusal(setup({ view: { current_version_number: 1, based_on_version_number: 1 } }).c.keepVersion(AUTH, 'copy-1', RID))).toMatchObject({ reason: 'already_current' });
    expect(await refusal(setup({ template: copy({ adopted_from_template_id: null }) }).c.keepVersion(AUTH, 'copy-1', RID))).toMatchObject({ reason: 'not_an_adopted_template' });
    expect(await refusal(setup({ master: null }).c.keepVersion(AUTH, 'copy-1', RID))).toMatchObject({ reason: 'master_not_available' });
  });
});
