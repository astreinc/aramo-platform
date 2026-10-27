import { describe, expect, it, vi } from 'vitest';

import type { DocumentTemplateView, TemplateVersionView } from '../document-templates-api';
import { studioBlocksFromHtml, studioVariableKeys } from '../studio-codec';

import { LETTERHEAD_STUDIO_CONTENT_CODEC } from './data-source';
import { newBlockId } from './doc-ops';
import {
  ORGANIZATION_STUDIO_SECTIONS,
  organizationStudioDataSource,
  type OrganizationStudioApi,
} from './organization-source';
import { organizationReadinessLabel } from './studio-copy';
import type { Readiness } from './readiness';

// TEMPLATE-STUDIO-1 S-1 — the organization data source of the shared Studio: the
// /v1/document-templates* mapping, the three capability states, no withdrawal / product
// tags / description, the letterhead codec, the Approve & activate copy and the static
// Sections set (existing catalog keys only).

const scoped = (scopes: string[]) => ({ scopes });
const MANAGER = scoped(['document_template:read', 'document_template:author', 'document_template:manage']);
const AUTHOR = scoped(['document_template:read', 'document_template:author']);
const READER = scoped(['document_template:read']);
const OPTS = { organizationHref: '/org/overview', listHref: '/org/document-templates' };

function tpl(over: Partial<DocumentTemplateView> = {}): DocumentTemplateView {
  return {
    id: 't1', tenant_id: 'x', document_type_id: 'rtr', client_id: null, name: 'Our RTR', description: null, template_kind: 'GENERATED',
    status: 'ACTIVE', current_version_id: 'v2', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', ...over,
  };
}
function ver(id: string, n: number, status: TemplateVersionView['status'], over: Partial<TemplateVersionView> = {}): TemplateVersionView {
  return {
    id, tenant_id: 'x', template_id: 't1', version_number: n, status, render_schema_version: 'rtr-html-v1', field_schema: {}, binding_schema: null,
    created_by: 'u', created_at: '2026-10-01T00:00:00.000Z', activated_at: null, activated_by: null, retired_at: null,
    content_fingerprint: null, previewed_fingerprint: null, ...over,
  };
}
function api(over: Partial<OrganizationStudioApi> = {}): Partial<OrganizationStudioApi> {
  return {
    getTemplate: vi.fn().mockResolvedValue(tpl()),
    listVersions: vi.fn().mockResolvedValue([ver('d3', 3, 'DRAFT', { logo: { asset_id: 'a1', mime: 'image/png' } }), ver('v2', 2, 'ACTIVE')]),
    catalog: vi.fn().mockResolvedValue({
      bindings: [
        { key: 'talent.full_name', label: 'Talent full name', group: 'Talent', data_type: 'TEXT', sample_value: 'Ravi', active: true },
        { key: 'old.key', label: 'Old', group: 'Talent', data_type: 'TEXT', sample_value: null, active: false },
        { key: 'bare.key', label: 'Bare', group: 'Other' },
      ],
      tenantLogo: { available: true, tenant_name: 'Astre' },
    }),
    library: vi.fn().mockResolvedValue({ items: [], document_types: [{ id: 'rtr', key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true }] }),
    createVersion: vi.fn().mockResolvedValue(ver('n1', 1, 'DRAFT')),
    createDraftFromActive: vi.fn().mockResolvedValue(ver('d3', 3, 'DRAFT')),
    updateDraft: vi.fn().mockResolvedValue(ver('d3', 3, 'DRAFT')),
    discardDraft: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue({ title: 'T', html: '<p>x</p>', sample_values: [], logo: { asset_id: 'a1', mime: 'image/png' } }),
    activate: vi.fn().mockResolvedValue(ver('d3', 3, 'ACTIVE')),
    rename: vi.fn().mockResolvedValue(tpl({ name: 'Renamed' })),
    ...over,
  };
}
const BODY = { render_schema_version: 'rtr-html-v1', field_schema: { render_schema_version: 'rtr-html-v1', title: 'T', html: '<p>x</p>' } };

describe('organizationStudioDataSource — capabilities (3 states)', () => {
  it('manage → edit + approve; author → edit only; read → neither; never withdrawal / product tags / description', () => {
    const m = organizationStudioDataSource({ session: MANAGER, ...OPTS }).capabilities;
    const a = organizationStudioDataSource({ session: AUTHOR, ...OPTS }).capabilities;
    const r = organizationStudioDataSource({ session: READER, ...OPTS }).capabilities;
    expect([m.canEdit, m.canApprove]).toEqual([true, true]);
    expect([a.canEdit, a.canApprove]).toEqual([true, false]);
    expect([r.canEdit, r.canApprove]).toEqual([false, false]);
    for (const c of [m, a, r]) expect([c.canWithdraw, c.productTags, c.description]).toEqual([false, false, false]);
    const ds = organizationStudioDataSource({ session: MANAGER, ...OPTS });
    expect(ds.withdraw).toBeUndefined();
    expect(ds.cancelWithdrawal).toBeUndefined();
    expect(ds.discardDraft).toBeDefined();
    expect(ds.content).toBe(LETTERHEAD_STUDIO_CONTENT_CODEC);
    expect(ds.copy.manageVariables).toBeUndefined();
  });
});

describe('organizationStudioDataSource — /v1/document-templates mapping', () => {
  it('load = GET /:id + GET /:id/versions (logo carried, no product tags, current version number)', async () => {
    const ds = organizationStudioDataSource({ session: MANAGER, ...OPTS, api: api() });
    const t = await ds.load('t1');
    expect(t.products).toEqual([]);
    expect(t.withdraw_effective_at).toBeNull();
    expect(t.current_version).toEqual({ id: 'v2', version_number: 2 });
    expect(t.versions.map((v) => v.id)).toEqual(['d3', 'v2']);
    expect(t.versions[0]?.logo).toEqual({ asset_id: 'a1', mime: 'image/png' });
  });

  it('catalog = allowed-bindings with the B-2 metadata (type, sample, active) + document types + the tenant logo', async () => {
    const ds = organizationStudioDataSource({ session: MANAGER, ...OPTS, api: api() });
    const c = await ds.catalog('t1');
    expect(c.variables).toEqual([
      { key: 'talent.full_name', label: 'Talent full name', group_label: 'Talent', data_type: 'TEXT', sample_value: 'Ravi', active: true },
      { key: 'old.key', label: 'Old', group_label: 'Talent', data_type: 'TEXT', sample_value: null, active: false },
      { key: 'bare.key', label: 'Bare', group_label: 'Other', data_type: '', sample_value: null, active: true },
    ]);
    expect(c.bindings.map((b) => b.key)).toEqual(['talent.full_name', 'old.key', 'bare.key']);
    expect(c.documentTypes).toEqual([{ id: 'rtr', name: 'Right to Represent' }]);
    expect(c.tenantLogo).toEqual({ available: true, tenant_name: 'Astre' });
  });

  it('createDraft: with an ACTIVE version → POST /:id/draft then PATCH the content; without one → POST /:id/versions', async () => {
    const a1 = api();
    await organizationStudioDataSource({ session: MANAGER, ...OPTS, api: a1 }).createDraft('t1', BODY);
    expect(a1.createDraftFromActive).toHaveBeenCalledWith('t1');
    expect(a1.updateDraft).toHaveBeenCalledWith('d3', BODY);
    expect(a1.createVersion).not.toHaveBeenCalled();

    const a2 = api({ getTemplate: vi.fn().mockResolvedValue(tpl({ current_version_id: null, status: 'DRAFT' })) });
    const v = await organizationStudioDataSource({ session: MANAGER, ...OPTS, api: a2 }).createDraft('t1', BODY);
    expect(a2.createVersion).toHaveBeenCalledWith('t1', BODY);
    expect(a2.createDraftFromActive).not.toHaveBeenCalled();
    expect(v.id).toBe('n1');
  });

  it('save = PATCH /versions/:id · discard = DELETE /versions/:id · preview = POST …/preview (logo kept) · approve = POST …/activate', async () => {
    const a = api();
    const ds = organizationStudioDataSource({ session: MANAGER, ...OPTS, api: a });
    await ds.saveDraft('d3', BODY);
    expect(a.updateDraft).toHaveBeenCalledWith('d3', BODY);
    await ds.discardDraft?.('d3');
    expect(a.discardDraft).toHaveBeenCalledWith('d3');
    expect(await ds.preview('d3')).toEqual({ title: 'T', html: '<p>x</p>', sample_values: [], logo: { asset_id: 'a1' } });
    expect((await ds.approve('d3')).status).toBe('ACTIVE');
    expect(a.activate).toHaveBeenCalledWith('d3');
  });

  it('updateProperties changes the name only (PATCH /:id {name})', async () => {
    const a = api();
    const ds = organizationStudioDataSource({ session: MANAGER, ...OPTS, api: a });
    expect((await ds.updateProperties?.('t1', { name: 'Renamed' }))?.name).toBe('Renamed');
    expect(a.rename).toHaveBeenCalledWith('t1', { name: 'Renamed' });
    await expect(ds.updateProperties?.('t1', { description: 'x' })).rejects.toThrow();
  });

  it('letterhead: capture / remove go to POST / DELETE …/versions/:id/logo; logoUrl is the content route', async () => {
    const captureLogo = vi.fn().mockResolvedValue({ asset_id: 'a2', mime: 'image/png' });
    const removeLogo = vi.fn().mockResolvedValue(undefined);
    const ds = organizationStudioDataSource({ session: MANAGER, ...OPTS, api: api({ captureLogo, removeLogo }) });
    await ds.letterhead?.capture('d3');
    await ds.letterhead?.remove('d3');
    expect(captureLogo).toHaveBeenCalledWith('d3');
    expect(removeLogo).toHaveBeenCalledWith('d3');
    expect(organizationStudioDataSource({ session: MANAGER, ...OPTS }).letterhead?.logoUrl('d3', 'a1')).toBe('/v1/document-templates/versions/d3/logo/content?v=a1');
  });
});

describe('organization copy (handoff §2, §6, §8)', () => {
  const copy = organizationStudioDataSource({ session: MANAGER, ...OPTS }).copy;
  it('Approve & activate vN… (Approve vN… below 1200px), the dialog, the consequence and the toast', () => {
    expect(copy.approveButton(4, true)).toBe('Approve & activate v4…');
    expect(copy.approveButton(4, false)).toBe('Approve v4…');
    expect(copy.approveDialog.title(4, 'Our RTR')).toBe('Approve version v4?');
    expect(copy.approveDialog.commit(4)).toBe('Approve & activate v4');
    expect(copy.approveDialog.consequence(4, 3)).toBe(
      'v4 becomes the template used for every future RTR. RTRs already sent stay pinned to the version they were sent with.',
    );
    expect(copy.approveToast(4)).toBe('v4 is active. New RTRs use it from now on.');
    expect(copy.crumbs).toEqual([{ label: 'Organization', to: '/org/overview' }, { label: 'Our templates', to: '/org/document-templates' }]);
    expect(organizationStudioDataSource({ session: AUTHOR, organizationHref: null, listHref: '/org/document-templates' }).copy.crumbs[0]).toEqual({ label: 'Organization' });
  });
  it('the readiness pill speaks of approval', () => {
    const r = (fails: number) => ({ ready: fails === 0, fails }) as unknown as Readiness;
    expect(organizationReadinessLabel(r(0), true)).toBe('Ready to approve');
    expect(organizationReadinessLabel(r(2), true)).toBe('2 issues before approval');
    expect(organizationReadinessLabel(r(1), false)).toBe('1 issue');
  });
});

describe('Organization Sections (directive §7.2)', () => {
  const RTR_KEYS = new Set([
    'talent.full_name', 'talent.desired_pay_rate', 'client.name', 'requisition.title', 'requisition.reference', 'requisition.description',
    'recruiting_company.name', 'recruiter.display_name', 'organization.name', 'organization.address_line1', 'organization.address_line2',
    'organization.city', 'organization.region', 'organization.postal_code', 'organization.country',
  ]);
  it('exactly the five named sections, built only from existing catalog keys, never agreed_pay_rate.*', () => {
    expect(ORGANIZATION_STUDIO_SECTIONS.map((s) => s.name)).toEqual([
      'Representation clause',
      'Job description',
      'Exclusivity',
      'Right to stop representation',
      'Recruiter sign-off',
    ]);
    for (const s of ORGANIZATION_STUDIO_SECTIONS) {
      const keys = studioBlocksFromHtml(s.html, newBlockId).flatMap((b) => studioVariableKeys(b.value));
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(RTR_KEYS.has(k)).toBe(true);
      expect(s.html).not.toContain('agreed_pay_rate');
    }
    expect(ORGANIZATION_STUDIO_SECTIONS.find((s) => s.key === 'job-description')?.html).toContain('data-field="requisition.description"');
  });
});
