import { createHash, randomUUID } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { type TemplatesRepository } from '@aramo/documents';
import { type RequisitionRepository } from '@aramo/requisition';
import { type TalentRecordRepository } from '@aramo/talent-record';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RTR_HTML_SCHEMA_V1 } from '../rtr/rtr-html-content.js';
import { RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';

import { episodeReaderAt } from './helpers/rtr-stage-fixture.js';

// Amendment A1 — rtr-html-v1 through the RTR request path: the resolver accepts exactly
// rtr-generated-v1 + rtr-html-v1, the binding service binds field nodes from the closed
// catalog (same fail-closed rules), the orchestrator reads the FROZEN logo asset (sha
// verified) for the letterhead, and the compose preview returns the real-bound html.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const TENANT = randomUUID();
const REQ_COMPANY = randomUUID();

function htmlContent(html: string, logo: unknown = null) {
  return { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'Exclusive RTR', html, logo };
}

async function code(p: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    return { code: (e as AramoError).code, details: (e as AramoError).context.details };
  }
  throw new Error('expected a refusal');
}

describe('A1 — rtr-html-v1 request path', () => {
  let versionContent: unknown;
  let renderSchema: string;
  let assetRow: { id: string; sha256: string; storage_locator: string } | null;
  let storedBytes: Buffer;
  let signing: { prepare: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; remind: ReturnType<typeof vi.fn> };
  let orch: RtrOrchestratorService;
  let binding: RtrTemplateBindingService;
  let resolver: RtrTemplateResolverService;
  let branding: { name: string; display_name: string | null; legal_name: string | null; logo_url: string | null };

  beforeEach(() => {
    renderSchema = RTR_HTML_SCHEMA_V1;
    versionContent = htmlContent('<h2>Scope</h2><p>Dear <b><span data-field="talent.full_name"></span></b>, rate <span data-field="talent.desired_pay_rate"></span>.</p>');
    assetRow = { id: 'asset-1', sha256: PNG_SHA, storage_locator: 'documents/t/template-assets/logo/x.png' };
    storedBytes = PNG;
    branding = { name: 'astre-ws', display_name: 'Astre', legal_name: 'Astre Consulting Services Inc.', logo_url: 'https://cdn.example/logo.png' };
    const templateId = randomUUID();
    const versionId = randomUUID();
    const templates = {
      // DOC-TEMPLATE-LIB-1 T-3 — selection-based resolution (tenant-wide selection → the
      // tenant's own TENANT template).
      findSelection: async (_t: string, _type: string, client: string | null) => (client === null ? { template_id: templateId } : null),
      findResolvablePlatformDefaults: async () => [],
      listWithdrawnPlatformDefaultIds: async () => [], // DOC-TEMPLATE-LIB-1 T-6
      findTemplateByIdOwnerAware: async () => ({
        id: templateId, current_version_id: versionId, name: 'Exclusive RTR', document_type_id: 'd0c50005-0000-7000-8000-000000000001',
        owner_scope: 'TENANT', status: 'ACTIVE', withdraw_effective_at: null,
      }),
      findVersionByIdOwnerAware: async () => ({ id: versionId, template_id: templateId, status: 'ACTIVE', render_schema_version: renderSchema, version_number: 2, field_schema: versionContent }),
      findAssetById: vi.fn(async () => assetRow),
    } as unknown as TemplatesRepository;
    const requisitions = {
      findCompanyId: async () => REQ_COMPANY,
      findStatusById: async () => 'open', // v1.2 §5.6 — pre-send CONTACT_SEND gate
      findByIdAdmin: async () => ({ title: 'BA', requisition_number: 7, description: null }),
    } as unknown as RequisitionRepository;
    const talent = { findById: async () => ({ first_name: 'Ravi', last_name: 'Shankar', email1: 'r@x.test', desired_pay: '70/hr' }) } as unknown as TalentRecordRepository;
    binding = new RtrTemplateBindingService(
      talent,
      requisitions,
      { findNamesByIds: async () => new Map([[REQ_COMPANY, 'Mindlance']]) } as never,
      { findLegalNameById: async () => 'Astre Consulting Services Inc.', findBrandingById: async () => branding } as never,
      { findUserById: async () => ({ display_name: 'Deepika' }) } as never,
    );
    resolver = new RtrTemplateResolverService(templates);
    signing = { prepare: vi.fn(async () => ({ document_id: 'd', revision_id: 'r' })), send: vi.fn(), remind: vi.fn() };
    const storage = { getArtifact: vi.fn(async () => storedBytes) };
    orch = new RtrOrchestratorService(
      { ensureRequirement: vi.fn(async () => undefined), getDocument: vi.fn() } as never,
      signing as never,
      talent,
      resolver,
      binding,
      templates,
      storage as never,
      requisitions,
      episodeReaderAt(), // Remediation v1.0 R2 (DEF-7) — the Talent has responded
    );
  });

  const req = { tenant_id: TENANT, talent_id: randomUUID(), requisition_id: randomUUID(), created_by: 'u', requestId: 'rq' };

  it('binds field nodes into rich runs (marks kept, values plain text) and never passes bound_html into the render model', async () => {
    await orch.request(req);
    const render = signing.prepare.mock.calls[0]?.[0].render;
    expect(render.render_schema_version).toBe('rich-v1');
    expect(render.blocks).toEqual([]);
    expect(render.rich_blocks[1].runs).toEqual([
      { text: 'Dear ', bold: false, italic: false, underline: false },
      { text: 'Ravi Shankar', bold: true, italic: false, underline: false },
      { text: ', rate ', bold: false, italic: false, underline: false },
      { text: '$70/hr', bold: false, italic: false, underline: false },
      { text: '.', bold: false, italic: false, underline: false },
    ]);
    expect(render.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
    expect(render.bound_html).toBeUndefined();
    expect(render.letterhead).toBeUndefined();
    expect(signing.prepare.mock.calls[0]?.[0].title).toBe('Exclusive RTR');
  });

  it('with a logo: reads the FROZEN asset bytes (sha-verified) into the letterhead with the branding name', async () => {
    versionContent = htmlContent('<div data-asset="tenant.logo"></div><p>Body</p>', { asset_id: 'asset-1', sha256: PNG_SHA, mime: 'image/png' });
    await orch.request(req);
    const lh = signing.prepare.mock.calls[0]?.[0].render.letterhead;
    expect(lh).toMatchObject({ image_format: 'PNG', image_sha256: PNG_SHA, name: 'Astre' });
    expect(Buffer.from(lh.image_bytes).equals(PNG)).toBe(true);
    // Name precedence: display_name → legal_name → workspace name.
    branding = { ...branding, display_name: null };
    await orch.request(req);
    expect(signing.prepare.mock.calls[1]?.[0].render.letterhead.name).toBe('Astre Consulting Services Inc.');
  });

  it('a logo whose stored bytes no longer match the frozen sha (or a missing asset) fails closed before any write', async () => {
    versionContent = htmlContent('<div data-asset="tenant.logo"></div><p>Body</p>', { asset_id: 'asset-1', sha256: PNG_SHA, mime: 'image/png' });
    storedBytes = Buffer.from('tampered');
    expect(await code(orch.request(req))).toEqual({ code: 'RTR_TEMPLATE_CONFIGURATION_INVALID', details: { reason: 'logo_asset_hash_mismatch' } });
    assetRow = null;
    expect(await code(orch.request(req))).toEqual({ code: 'RTR_TEMPLATE_CONFIGURATION_INVALID', details: { reason: 'logo_asset_missing' } });
    expect(signing.prepare).not.toHaveBeenCalled();
  });

  it('a missing bound value fails closed exactly like v1 (RTR_TEMPLATE_BINDING_MISSING)', async () => {
    versionContent = htmlContent('<p><span data-field="requisition.description"></span></p>');
    expect((await code(orch.request(req))).code).toBe('RTR_TEMPLATE_BINDING_MISSING');
  });

  it('resolver: a stored html that is no longer allowlist-clean, or an unknown content version, fails closed', async () => {
    versionContent = htmlContent('<p><span data-field="agreed_pay_rate.amount"></span></p>');
    expect(await code(resolver.resolveActive({ tenant_id: TENANT, requestId: 'r' }))).toMatchObject({ code: 'RTR_TEMPLATE_CONFIGURATION_INVALID', details: { reason: 'content_schema_invalid' } });
    renderSchema = 'rtr-html-v2';
    expect(await code(resolver.resolveActive({ tenant_id: TENANT, requestId: 'r' }))).toMatchObject({ details: { reason: 'unrecognised_render_schema_version' } });
  });

  it('compose preview returns the REAL-bound html (field nodes → data-sample spans with escaped real values)', async () => {
    const view = await orch.composeForPair({ tenant_id: TENANT, talent_id: randomUUID(), requisition_id: randomUUID(), actor_id: 'u', requestId: 'r' });
    expect(view.preview.html).toBe(
      '<h2>Scope</h2><p>Dear <b><span data-sample="talent.full_name">Ravi Shankar</span></b>, rate <span data-sample="talent.desired_pay_rate">$70/hr</span>.</p>',
    );
    expect(view.preview.blocks).toEqual([]);
    expect(view.preview.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
  });
});
