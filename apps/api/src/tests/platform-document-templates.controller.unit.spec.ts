import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import {
  TemplatePlatformDefaultConflictError,
  TemplatePreviewRequiredError,
  TemplateVariableKeyConflictError,
  type TemplateAuditPort,
  type TemplateCapabilitiesPort,
  type TemplateVariablesRepository,
  type TemplatesRepository,
} from '@aramo/documents';
import { describe, expect, it, vi } from 'vitest';

import { PlatformDocumentTemplatesController } from '../document-templates-platform/platform-document-templates.controller.js';

// DOC-TEMPLATE-LIB-1 T-2 (§6.1) — the platform-tier Aramo default template + variable
// catalog routes: class guards (JwtAuthGuard + RolesGuard), per-route platform scopes
// (reads → :read, writes → :manage), the consumer_type=platform tripwire on EVERY route
// (checked before any repository call), and the error mapping.

const READ = 'platform:document_template:read';
const MANAGE = 'platform:document_template:manage';
const RID = 'req-1';
const ID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const TYPE = 'd0c50005-0000-7000-8000-000000000001';

const ROUTE_SCOPES: Record<string, string> = {
  listDocumentTypes: READ,
  list: READ,
  get: READ,
  allowedBindings: READ,
  getVersion: READ,
  listVariables: READ,
  create: MANAGE,
  update: MANAGE,
  createDraft: MANAGE,
  updateDraft: MANAGE,
  preview: MANAGE,
  publish: MANAGE,
  createVariable: MANAGE,
  updateVariable: MANAGE,
  // DOC-TEMPLATE-LIB-1 T-6 (§9).
  withdraw: MANAGE,
  cancelWithdrawal: MANAGE,
};

function auth(consumer_type: string, scopes: string[] = [READ, MANAGE]): AuthContextType {
  return {
    sub: '01900000-0000-7000-8000-0000000ac001',
    consumer_type: consumer_type as AuthContextType['consumer_type'],
    actor_kind: 'user' as AuthContextType['actor_kind'],
    tenant_id: '01900000-0000-7000-8000-000000000100',
    scopes,
    iat: 0,
    exp: 0,
  };
}

function build() {
  const templates = {
    listSystemDocumentTypes: vi.fn(async () => [{ id: TYPE, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent' }]),
    listPlatformTemplates: vi.fn(async () => []),
    createPlatformTemplate: vi.fn(async (i: Record<string, unknown>) => ({
      id: ID,
      owner_scope: 'PLATFORM',
      document_type_id: i['document_type_id'],
      name: i['name'],
      description: null,
      template_kind: i['template_kind'],
      status: 'DRAFT',
      products: i['products'],
      current_version_id: null,
      withdraw_notice_at: null,
      withdraw_effective_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    })),
    getPlatformTemplate: vi.fn(async () => ({ id: ID, document_type_id: TYPE })),
    getPlatformVersion: vi.fn(async () => ({ id: VID, template_id: ID, status: 'DRAFT', field_schema: {}, render_schema_version: 'rtr-html-v1' })),
    activatePlatformVersion: vi.fn(async () => ({ id: VID, status: 'ACTIVE' })),
    recordPlatformPreview: vi.fn(async () => ({})),
    updatePlatformDraftVersion: vi.fn(async () => ({ id: VID })),
    listPlatformVersions: vi.fn(async () => []),
    // T-6 — the repository runs the beforeWrite hook (audit) then returns the row.
    withdrawPlatformTemplate: vi.fn(
      async (i: { id: string; notice_days: number; beforeWrite?: (p: unknown) => Promise<void> }) => {
        const now = new Date('2026-10-21T00:00:00.000Z');
        const eff = new Date(now.getTime() + i.notice_days * 86_400_000);
        await i.beforeWrite?.({ template: { id: i.id, document_type_id: TYPE }, withdraw_notice_at: now, withdraw_effective_at: eff });
        return { ...PUBLISHED_ROW, withdraw_notice_at: now, withdraw_effective_at: eff };
      },
    ),
    cancelPlatformWithdrawal: vi.fn(async (i: { id: string; beforeWrite?: (p: unknown) => Promise<void> }) => {
      await i.beforeWrite?.({
        template: { id: i.id, document_type_id: TYPE },
        withdraw_notice_at: new Date('2026-10-21T00:00:00.000Z'),
        withdraw_effective_at: new Date('2026-10-28T00:00:00.000Z'),
      });
      return PUBLISHED_ROW;
    }),
  };
  const audit = {
    recordDraftDiscarded: vi.fn(async () => undefined),
    recordPlatformWithdrawal: vi.fn(async () => undefined),
    recordGovernance: vi.fn(async () => undefined),
  };
  const variables = {
    listAll: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  };
  const caps = {
    isConfigurable: vi.fn(() => true),
    listAllowedBindings: vi.fn(async () => []),
    validateDraftContent: vi.fn(async () => undefined),
    renderSamplePreview: vi.fn(async () => ({ title: 't', blocks: [] })),
    normalizeDraftContent: vi.fn(async (i: { field_schema: unknown }) => i.field_schema),
    draftContentFrom: vi.fn(),
    logoOf: vi.fn(() => null),
    withLogo: vi.fn(),
  };
  const c = new PlatformDocumentTemplatesController(
    templates as unknown as TemplatesRepository,
    variables as unknown as TemplateVariablesRepository,
    caps as unknown as TemplateCapabilitiesPort,
    audit as unknown as TemplateAuditPort,
  );
  return { c, templates, variables, caps, audit };
}

const PUBLISHED_ROW = {
  id: ID,
  owner_scope: 'PLATFORM',
  document_type_id: TYPE,
  name: 'Aramo standard RTR',
  description: null,
  template_kind: 'GENERATED',
  status: 'ACTIVE',
  products: ['ATS'],
  current_version_id: VID,
  withdraw_notice_at: null as Date | null,
  withdraw_effective_at: null as Date | null,
  created_at: new Date(),
  updated_at: new Date(),
};

// Invoke one route handler with (args…, auth, requestId) in its declared order.
function call(c: PlatformDocumentTemplatesController, name: string, a: AuthContextType): Promise<unknown> {
  const m = c as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  switch (name) {
    case 'listDocumentTypes':
    case 'list':
    case 'listVariables':
      return m[name]!(a, RID);
    case 'get':
    case 'allowedBindings':
    case 'cancelWithdrawal':
      return m[name]!(ID, a, RID);
    case 'withdraw':
      return m[name]!(ID, {}, a, RID);
    case 'getVersion':
    case 'preview':
    case 'publish':
      return m[name]!(VID, a, RID);
    case 'create':
    case 'createVariable':
      return m[name]!({}, a, RID);
    case 'update':
    case 'createDraft':
      return m[name]!(ID, { name: 'x' }, a, RID);
    case 'updateDraft':
      return m[name]!(VID, { internal_notes: 'x' }, a, RID);
    case 'updateVariable':
      return m[name]!(ID, { label: 'x' }, a, RID);
    default:
      throw new Error(`unmapped route ${name}`);
  }
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; statusCode?: number; context?: { details?: Record<string, unknown> } }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; statusCode?: number };
  }
  return { code: 'NO_THROW' };
}

describe('PlatformDocumentTemplatesController — authorization surface', () => {
  it('class guards are JwtAuthGuard + RolesGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PlatformDocumentTemplatesController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('every route carries exactly one platform:document_template scope (reads → read, writes → manage)', () => {
    const proto = PlatformDocumentTemplatesController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && Reflect.getMetadata('path', proto[n] as object) !== undefined,
    );
    expect(handlers.sort()).toEqual(Object.keys(ROUTE_SCOPES).sort());
    for (const h of handlers) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto[h] as object), h).toEqual([ROUTE_SCOPES[h]]);
    }
  });

  it.each(Object.keys(ROUTE_SCOPES))('%s refuses a tenant-tier token (tier_mismatch) before any repository call', async (name) => {
    const { c, templates, variables } = build();
    for (const consumer of ['recruiter', 'portal', 'ingestion']) {
      const e = await errorOf(call(c, name, auth(consumer)));
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.statusCode).toBe(403);
      expect(e.context?.details?.['reason']).toBe('tier_mismatch');
    }
    for (const fn of [...Object.values(templates), ...Object.values(variables)]) expect(fn).not.toHaveBeenCalled();
  });

  it('RolesGuard: a platform token without :manage is refused on a write route; with it, admitted', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (scopes: string[]): ExecutionContext =>
      ({
        getHandler: () => PlatformDocumentTemplatesController.prototype.publish,
        getClass: () => PlatformDocumentTemplatesController,
        switchToHttp: () => ({ getRequest: () => ({ authContext: auth('platform', scopes), requestId: RID }) }),
      }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx([READ]))).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(() => guard.canActivate(ctx(['document_template:manage']))).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(guard.canActivate(ctx([READ, MANAGE]))).toBe(true);
  });
});

describe('PlatformDocumentTemplatesController — behaviour', () => {
  it('create: only an active SYSTEM document type; products validated + de-duplicated; PLATFORM row returned', async () => {
    const { c, templates } = build();
    const bad = await errorOf(c.create({ document_type_id: 'tenant-type', name: 'N', template_kind: 'GENERATED' }, auth('platform'), RID));
    expect(bad.code).toBe('VALIDATION_ERROR');
    expect(bad.context?.details?.['reason']).toBe('document_type_not_system');
    expect((await errorOf(c.create({ document_type_id: TYPE, name: 'N', template_kind: 'GENERATED', products: ['ats'] }, auth('platform'), RID))).code).toBe('VALIDATION_ERROR');
    const v = await c.create({ document_type_id: TYPE, name: ' Standard RTR ', template_kind: 'GENERATED', products: ['ATS', 'ATS', 'SIGN'] }, auth('platform'), RID);
    expect(templates.createPlatformTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Standard RTR', products: ['ATS', 'SIGN'] }));
    expect(v).toMatchObject({ owner_scope: 'PLATFORM', products: ['ATS', 'SIGN'], current_version: null, draft_version_id: null });
  });

  it('publish: validates content against the catalog, then activates; the preview gate refusal maps to 409 TEMPLATE_PREVIEW_REQUIRED', async () => {
    const { c, templates, caps } = build();
    templates.activatePlatformVersion.mockRejectedValueOnce(new TemplatePreviewRequiredError(VID));
    const e = await errorOf(c.publish(VID, auth('platform'), RID));
    expect(caps.validateDraftContent).toHaveBeenCalledWith(expect.objectContaining({ document_type_id: TYPE, requestId: RID }));
    expect(e.code).toBe('TEMPLATE_PREVIEW_REQUIRED');
    expect(e.statusCode).toBe(409);
    await expect(c.publish(VID, auth('platform'), RID)).resolves.toMatchObject({ status: 'ACTIVE', logo: null });
  });

  it('preview: renders samples via the capability, then records the preview (arming the gate)', async () => {
    const { c, templates, caps } = build();
    await c.preview(VID, auth('platform'), RID);
    expect(caps.renderSamplePreview).toHaveBeenCalled();
    expect(templates.recordPlatformPreview).toHaveBeenCalledWith(VID);
  });

  it('variables: key validated on create; immutable on update; duplicate key → 409 key_exists', async () => {
    const { c, variables } = build();
    expect((await errorOf(c.createVariable({ key: 'Bad Key', label: 'L', group_label: 'G', data_type: 'TEXT' }, auth('platform'), RID))).context?.details?.['reason']).toBe('invalid_key');
    expect((await errorOf(c.updateVariable(ID, { key: 'x.y' }, auth('platform'), RID))).context?.details?.['reason']).toBe('key_immutable');
    variables.create.mockRejectedValueOnce(new TemplateVariableKeyConflictError('talent.full_name'));
    const dup = await errorOf(c.createVariable({ key: 'talent.full_name', label: 'L', group_label: 'G', data_type: 'TEXT' }, auth('platform'), RID));
    expect(dup.statusCode).toBe(409);
    expect(dup.context?.details?.['reason']).toBe('key_exists');
    expect((await errorOf(c.createVariable({ key: 'a.b', label: 'L', group_label: 'G', data_type: 'BOOLEAN' }, auth('platform'), RID))).code).toBe('VALIDATION_ERROR');
  });
});

// DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — withdrawal routes.
describe('PlatformDocumentTemplatesController — withdrawal (T-6)', () => {
  it('withdraw: notice_days defaults to 7; the audit event is written (global, before the write) with the planned dates + reason', async () => {
    const { c, templates, audit } = build();
    const v = await c.withdraw(ID, { reason: ' Superseded ' }, auth('platform'), RID);
    expect(templates.withdrawPlatformTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: ID, notice_days: 7 }));
    expect(audit.recordPlatformWithdrawal).toHaveBeenCalledWith({
      action: 'published',
      actor_id: auth('platform').sub,
      template_id: ID,
      document_type_id: TYPE,
      withdraw_notice_at: '2026-10-21T00:00:00.000Z',
      withdraw_effective_at: '2026-10-28T00:00:00.000Z',
      notice_days: 7,
      reason: 'Superseded',
      requestId: RID,
    });
    expect(v).toMatchObject({ withdraw_notice_at: new Date('2026-10-21T00:00:00.000Z'), withdraw_effective_at: new Date('2026-10-28T00:00:00.000Z') });
  });

  it('withdraw: notice_days must be an integer 0..365 (0 = effective immediately)', async () => {
    const { c, templates } = build();
    for (const bad of [-1, 366, 1.5, '7']) {
      const e = await errorOf(c.withdraw(ID, { notice_days: bad }, auth('platform'), RID));
      expect(e.code, String(bad)).toBe('VALIDATION_ERROR');
      expect(e.context?.details?.['reason']).toBe('invalid_notice_days');
    }
    expect(templates.withdrawPlatformTemplate).not.toHaveBeenCalled();
    await c.withdraw(ID, { notice_days: 0 }, auth('platform'), RID);
    expect(templates.withdrawPlatformTemplate).toHaveBeenCalledWith(expect.objectContaining({ notice_days: 0 }));
    await c.withdraw(ID, { notice_days: 365 }, auth('platform'), RID);
    expect(templates.withdrawPlatformTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ notice_days: 365 }));
  });

  it('a lifecycle refusal maps to 409 TEMPLATE_PLATFORM_DEFAULT_CONFLICT with details.reason', async () => {
    const { c, templates } = build();
    templates.withdrawPlatformTemplate.mockRejectedValueOnce(new TemplatePlatformDefaultConflictError(ID, 'already_withdrawn'));
    const e = await errorOf(c.withdraw(ID, {}, auth('platform'), RID));
    expect(e.code).toBe('TEMPLATE_PLATFORM_DEFAULT_CONFLICT');
    expect(e.statusCode).toBe(409);
    expect(e.context?.details?.['reason']).toBe('already_withdrawn');
    templates.cancelPlatformWithdrawal.mockRejectedValueOnce(new TemplatePlatformDefaultConflictError(ID, 'withdrawal_in_effect'));
    const e2 = await errorOf(c.cancelWithdrawal(ID, auth('platform'), RID));
    expect(e2.statusCode).toBe(409);
    expect(e2.context?.details?.['reason']).toBe('withdrawal_in_effect');
  });

  it('cancel: writes the cancelled audit event with the dates being cleared', async () => {
    const { c, audit } = build();
    await c.cancelWithdrawal(ID, auth('platform'), RID);
    expect(audit.recordPlatformWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cancelled', template_id: ID, withdraw_effective_at: '2026-10-28T00:00:00.000Z' }),
    );
  });

  it('a failing audit write aborts the withdrawal (the hook throws before the write)', async () => {
    const { c, audit } = build();
    audit.recordPlatformWithdrawal.mockRejectedValueOnce(new Error('audit down'));
    const e = await errorOf(c.withdraw(ID, {}, auth('platform'), RID));
    expect(e.code).toBe('INTERNAL_ERROR');
  });

  it('refuses withdrawal when no audit seam is bound (audit is a MUST)', async () => {
    const { templates, variables, caps } = build();
    const bare = new PlatformDocumentTemplatesController(
      templates as unknown as TemplatesRepository,
      variables as unknown as TemplateVariablesRepository,
      caps as unknown as TemplateCapabilitiesPort,
    );
    expect((await errorOf(bare.withdraw(ID, {}, auth('platform'), RID))).code).toBe('INTERNAL_ERROR');
    expect((await errorOf(bare.cancelWithdrawal(ID, auth('platform'), RID))).code).toBe('INTERNAL_ERROR');
    expect(templates.withdrawPlatformTemplate).not.toHaveBeenCalled();
  });

  it('D9: list/get expose product tags as recorded (no filtering)', async () => {
    const { c, templates } = build();
    templates.listPlatformTemplates.mockResolvedValueOnce([{ ...PUBLISHED_ROW, products: ['SIGN'], versions: [] }] as never);
    const r = await c.list(auth('platform'), RID);
    expect(r.templates[0]?.products).toEqual(['SIGN']);
  });
});
