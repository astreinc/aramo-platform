import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  DOCUMENT_EXECUTION_MODES,
  DOCUMENT_TYPE_TEMPLATE_KINDS,
  PlatformDocumentTypesRepository,
  SYSTEM_LOCKED_EDITABLE_FIELDS,
  TEMPLATE_AUDIT,
  TEMPLATE_PRODUCT_KEYS,
  documentTypeKeyFromName,
  isSystemLockedType,
  isTemplateProductKey,
  templateErrorToHttp,
  type DocumentTypeTemplateKind,
  type PlatformDocumentTypeRow,
  type TemplateAuditPort,
  type TemplateProductKey,
  type UpdateSystemDocumentTypeInput,
} from '@aramo/documents';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §4.3 — Platform Admin management
// of the SYSTEM document types (the "Document types" screen, §4.4). Served under /platform
// (nginx routes /platform/document-types to api:3000, like /platform/document-templates).
//
// Same AuthZ posture as PlatformDocumentTemplatesController: class-level
// @UseGuards(JwtAuthGuard, RolesGuard); reads → platform:document_template:read, writes →
// platform:document_template:manage; the consumer_type === 'platform' tripwire on every route.
//
//   GET    document-types              every SYSTEM row, both classes (TEMPLATE + UPLOAD)
//   POST   document-types              create (scope SYSTEM, system_defined false, TEMPLATE;
//                                      key = upper snake of the name, 409 key_exists)
//   PATCH  document-types/:id          name, description, category, products, kind,
//                                      retention_class, execution_mode_default
//   POST   document-types/:id/retire   active = false (refused while a default is live)
//   DELETE document-types/:id          only an unreferenced, non-seeded type
//
// Each write records a GLOBAL audit event (identity.document_type.created | updated | retired
// | deleted) through the TEMPLATE_AUDIT port BEFORE the change; refused (500) without the port.

const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;
const CATEGORY_MAX = 60;

export type DocumentTypeBadge = 'SYSTEM' | 'SEEDED' | null;

export interface PlatformDocumentTypeView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type_class: string;
  template_kind: string | null;
  products: string[];
  category: string | null;
  retention_class: string;
  execution_mode_default: string;
  active: boolean;
  system_defined: boolean;
  // §4.4 — System (code depends on it, §4.2), Seeded (other system_defined), null (created here).
  badge: DocumentTypeBadge;
  // §4.2 — the fields this screen may change (empty for an UPLOAD type).
  editable_fields: string[];
  templates_count: number;
  live_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const ALL_FIELDS = ['name', 'description', 'category', 'template_kind', 'products', 'retention_class', 'execution_mode_default'];

function toView(t: PlatformDocumentTypeRow, usage: { templates_count: number; live_default: boolean }): PlatformDocumentTypeView {
  const locked = isSystemLockedType(t.id);
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    type_class: t.type_class,
    template_kind: t.template_kind,
    products: [...t.products],
    category: t.category,
    retention_class: t.retention_class,
    execution_mode_default: t.execution_mode_default,
    active: t.active,
    system_defined: t.system_defined,
    badge: locked ? 'SYSTEM' : t.system_defined ? 'SEEDED' : null,
    editable_fields: t.type_class === 'UPLOAD' ? [] : locked ? [...(SYSTEM_LOCKED_EDITABLE_FIELDS[t.id] ?? [])] : [...ALL_FIELDS],
    templates_count: usage.templates_count,
    live_default: usage.live_default,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function invalid(message: string, requestId: string, reason: string, status = 422): AramoError {
  return new AramoError('VALIDATION_ERROR', message, status, { requestId, details: { reason } });
}

function requiredText(v: unknown, field: string, max: number, requestId: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length === 0) throw invalid(`${field} is required`, requestId, `${field}_required`, 400);
  if (s.length > max) throw invalid(`${field} must be at most ${max} characters`, requestId, `${field}_too_long`, 400);
  return s;
}

function optionalText(v: unknown, field: string, max: number, requestId: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw invalid(`${field} must be a string or null`, requestId, `${field}_invalid`, 400);
  const s = v.trim();
  if (s.length > max) throw invalid(`${field} must be at most ${max} characters`, requestId, `${field}_too_long`, 400);
  return s.length === 0 ? null : s;
}

// §4.4 — products (dropdown, ≥1): the template product keys only (§2).
function typeProducts(v: unknown, requestId: string): TemplateProductKey[] {
  if (!Array.isArray(v)) throw invalid('products must be an array of product keys', requestId, 'invalid_product');
  const out: TemplateProductKey[] = [];
  for (const p of v) {
    if (!isTemplateProductKey(p)) throw invalid(`invalid product: ${String(p)} (allowed: ${TEMPLATE_PRODUCT_KEYS.join(', ')})`, requestId, 'invalid_product');
    if (!out.includes(p)) out.push(p);
  }
  if (out.length === 0) throw invalid('choose at least one product', requestId, 'products_required');
  return TEMPLATE_PRODUCT_KEYS.filter((k) => out.includes(k));
}

function templateKind(v: unknown, requestId: string): DocumentTypeTemplateKind {
  if (typeof v !== 'string' || !(DOCUMENT_TYPE_TEMPLATE_KINDS as readonly string[]).includes(v)) {
    throw invalid(`template_kind must be one of ${DOCUMENT_TYPE_TEMPLATE_KINDS.join(', ')}`, requestId, 'invalid_template_kind');
  }
  return v as DocumentTypeTemplateKind;
}

function executionMode(v: unknown, requestId: string): string {
  if (typeof v !== 'string' || !(DOCUMENT_EXECUTION_MODES as readonly string[]).includes(v)) {
    throw invalid(`execution_mode_default must be one of ${DOCUMENT_EXECUTION_MODES.join(', ')}`, requestId, 'invalid_execution_mode');
  }
  return v;
}

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformDocumentTypesController {
  constructor(
    private readonly types: PlatformDocumentTypesRepository,
    // The template audit seam (@Global, bound in apps/api). @Optional only so the class can
    // be unit-built; every write REFUSES when it is absent (audit is a MUST).
    @Optional() @Inject(TEMPLATE_AUDIT) private readonly audit?: TemplateAuditPort,
  ) {}

  @Get('document-types')
  @RequireScopes('platform:document_template:read')
  async list(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ document_types: PlatformDocumentTypeView[]; retention_classes: string[]; execution_modes: string[] }> {
    this.assertPlatform(auth, requestId);
    const [rows, retention_classes] = await Promise.all([this.types.listWithUsage(), this.types.listRetentionClasses()]);
    return { document_types: rows.map((r) => toView(r, r)), retention_classes, execution_modes: [...DOCUMENT_EXECUTION_MODES] };
  }

  @Post('document-types')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:document_template:manage')
  async create(
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PlatformDocumentTypeView> {
    this.assertPlatform(auth, requestId);
    const name = requiredText(body?.['name'], 'name', NAME_MAX, requestId);
    const key = documentTypeKeyFromName(name);
    if (key.length === 0) throw invalid('name must contain a letter or a digit', requestId, 'name_invalid', 400);
    const description = optionalText(body?.['description'], 'description', DESCRIPTION_MAX, requestId);
    const category = optionalText(body?.['category'], 'category', CATEGORY_MAX, requestId);
    const template_kind = templateKind(body?.['template_kind'], requestId);
    const products = typeProducts(body?.['products'], requestId);
    const execution_mode_default = executionMode(body?.['execution_mode_default'], requestId);
    const retention_class = await this.retentionClass(body?.['retention_class'], requestId);
    const audit = this.requireAudit(requestId);
    return this.run(requestId, async () => {
      const t = await this.types.create(
        { key, name, description, category, template_kind, products, retention_class, execution_mode_default },
        (p) => audit.recordPlatformDocumentType({ action: 'created', actor_id: auth.sub, document_type_id: p.id, key: p.key, name: p.name, requestId }),
      );
      return toView(t, { templates_count: 0, live_default: false });
    });
  }

  @Patch('document-types/:id')
  @RequireScopes('platform:document_template:manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PlatformDocumentTypeView> {
    this.assertPlatform(auth, requestId);
    const b = body ?? {};
    const patch: { -readonly [K in keyof UpdateSystemDocumentTypeInput]: UpdateSystemDocumentTypeInput[K] } = {};
    if ('name' in b) patch.name = requiredText(b['name'], 'name', NAME_MAX, requestId);
    if ('description' in b) patch.description = optionalText(b['description'], 'description', DESCRIPTION_MAX, requestId);
    if ('category' in b) patch.category = optionalText(b['category'], 'category', CATEGORY_MAX, requestId);
    if ('template_kind' in b) patch.template_kind = templateKind(b['template_kind'], requestId);
    if ('products' in b) patch.products = typeProducts(b['products'], requestId);
    if ('execution_mode_default' in b) patch.execution_mode_default = executionMode(b['execution_mode_default'], requestId);
    if ('retention_class' in b) patch.retention_class = await this.retentionClass(b['retention_class'], requestId);
    if (Object.keys(patch).length === 0) throw invalid('no updatable field supplied', requestId, 'empty_patch', 400);
    const audit = this.requireAudit(requestId);
    return this.run(requestId, async () => {
      const r = await this.types.update(id, patch, ({ type, changed_fields }) =>
        audit.recordPlatformDocumentType({ action: 'updated', actor_id: auth.sub, document_type_id: type.id, key: type.key, name: type.name, changed_fields, requestId }),
      );
      return this.viewOf(r.type);
    });
  }

  @Post('document-types/:id/retire')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:document_template:manage')
  async retire(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PlatformDocumentTypeView> {
    this.assertPlatform(auth, requestId);
    const audit = this.requireAudit(requestId);
    return this.run(requestId, async () => {
      const t = await this.types.retire(id, ({ type }) =>
        audit.recordPlatformDocumentType({ action: 'retired', actor_id: auth.sub, document_type_id: type.id, key: type.key, name: type.name, requestId }),
      );
      return this.viewOf(t);
    });
  }

  @Delete('document-types/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('platform:document_template:manage')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<void> {
    this.assertPlatform(auth, requestId);
    const audit = this.requireAudit(requestId);
    await this.run(requestId, () =>
      this.types.delete(id, ({ type }) =>
        audit.recordPlatformDocumentType({ action: 'deleted', actor_id: auth.sub, document_type_id: type.id, key: type.key, name: type.name, requestId }),
      ),
    );
  }

  // ---- Internal ----------------------------------------------------------

  private async viewOf(t: PlatformDocumentTypeRow): Promise<PlatformDocumentTypeView> {
    const usage = (await this.types.listWithUsage()).find((r) => r.id === t.id);
    return toView(t, usage ?? { templates_count: 0, live_default: false });
  }

  // §4.4 — "retention class (existing values)": one already used by a document type.
  private async retentionClass(v: unknown, requestId: string): Promise<string> {
    const allowed = await this.types.listRetentionClasses();
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new AramoError('VALIDATION_ERROR', `retention_class must be one of ${allowed.join(', ')}`, 422, {
        requestId,
        details: { reason: 'invalid_retention_class', allowed },
      });
    }
    return v;
  }

  private requireAudit(requestId: string): TemplateAuditPort {
    if (this.audit === undefined) {
      throw new AramoError('INTERNAL_ERROR', 'Template audit is not configured; document type change refused', 500, { requestId });
    }
    return this.audit;
  }

  private assertPlatform(auth: AuthContextType, requestId: string): void {
    // DDR §13.1 tripwire app-side — a tenant token cannot satisfy a platform route.
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
  }

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw templateErrorToHttp(e, requestId);
    }
  }
}
