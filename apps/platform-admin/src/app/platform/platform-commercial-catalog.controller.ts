import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards, type PipeTransform } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  CommercialCatalogError,
  CommercialCatalogService,
  CommercialPolicyUnavailableError,
  type CatalogDraftEdits,
  type CatalogVersionSummary,
  type CommercialActor,
  type CommercialCallContext,
} from '@aramo/subscription';

import {
  type CatalogResponseDto,
  type CatalogVersionDetailDto,
  type CatalogVersionSummaryDto,
  CreateCatalogDraftDto,
  UUID_SHAPE,
  UpdateCatalogDraftDto,
} from './dto/commercial-catalog.dto.js';

/** A path id with the uuid shape (see UUID_SHAPE: the A5 v1 version ids are md5-derived). */
class UuidShapePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    // The same refusal ParseUUIDPipe raises (the exception filter maps it to 400 VALIDATION_ERROR).
    if (typeof value !== 'string' || !UUID_SHAPE.test(value)) throw new BadRequestException('Validation failed (uuid is expected)');
    return value.toLowerCase();
  }
}

// CCP-B2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B2) — the product and plan
// catalog behind the platform console's Catalog screen. Platform consumer only.
//
// Route gates: the reads need `platform:catalog:read` (all 6 CCP roles; never super_admin);
// the draft writes need `platform:catalog:draft` (catalog_manager only). Below the gate the
// CommercialCatalogService is the authority: a human principal; DRAFT only (a PUBLISHED or
// RETIRED version is refused 409 COMMERCIAL_CATALOG_CONFLICT `not_draft` — and the N-16 DB
// trigger refuses it anyway); one DRAFT per plan; only price, envelopes per month and storage
// are editable.
//
// There is deliberately NO publish, retire or apply route: publishing and retiring are
// PLAN_VERSION_PUBLISH / PLAN_RETIRE change requests (POST /platform/commercial/change-requests,
// Finance → Owner), applied by CCP-A6 (PLATFORM-UX-1 Amendment A1-2).

@Controller('platform/commercial/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialCatalogController {
  constructor(private readonly catalog: CommercialCatalogService) {}

  @Get()
  @RequireScopes('platform:catalog:read')
  async read(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<CatalogResponseDto> {
    platformOnly(auth, requestId);
    const view = await run(requestId, () => this.catalog.readCatalog());
    return {
      products: view.products.map((p) => ({ product_key: p.product_key, plans: p.plans.map((pl) => ({ ...pl, versions: pl.versions.map(summaryDto) })) })),
      publish_chain: view.publish_chain,
    };
  }

  @Get('versions/:versionId')
  @RequireScopes('platform:catalog:read')
  async readVersion(
    @Param('versionId', new UuidShapePipe()) versionId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CatalogVersionDetailDto> {
    platformOnly(auth, requestId);
    const d = await run(requestId, () => this.catalog.readVersion(versionId));
    return { version: summaryDto(d.version), plan: d.plan, content: d.content as unknown as Record<string, unknown>, pinned_tenants: d.pinned_tenants };
  }

  @Post('plans/:planId/drafts')
  @HttpCode(201)
  @RequireScopes('platform:catalog:draft')
  async createDraft(
    @Param('planId', new UuidShapePipe()) planId: string,
    @Body() body: CreateCatalogDraftDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ version: CatalogVersionSummaryDto }> {
    platformOnly(auth, requestId);
    const v = await run(requestId, () => this.catalog.createDraft(actorOf(auth), planId, { from_version_id: body.from_version_id, note: body.note ?? null }, ctxOf(requestId)));
    return { version: summaryDto(v) };
  }

  @Patch('versions/:versionId')
  @RequireScopes('platform:catalog:draft')
  async updateDraft(
    @Param('versionId', new UuidShapePipe()) versionId: string,
    @Body() body: UpdateCatalogDraftDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ version: CatalogVersionSummaryDto }> {
    platformOnly(auth, requestId);
    const edits: { -readonly [K in keyof CatalogDraftEdits]: CatalogDraftEdits[K] } = {};
    if (body.list_price_minor !== undefined) edits.list_price_minor = body.list_price_minor;
    if (body.envelopes_per_month !== undefined) edits.envelopes_per_month = body.envelopes_per_month;
    if (body.storage_bytes !== undefined) edits.storage_bytes = body.storage_bytes;
    const v = await run(requestId, () =>
      this.catalog.updateDraft(actorOf(auth), versionId, { expected_content_checksum: body.expected_content_checksum, edits, ...(body.note !== undefined ? { note: body.note } : {}) }, ctxOf(requestId)),
    );
    return { version: summaryDto(v) };
  }
}

function platformOnly(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

async function run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toCatalogAramoError(err, requestId);
  }
}

export function toCatalogAramoError(err: unknown, requestId: string): unknown {
  if (err instanceof CommercialPolicyUnavailableError) {
    return new AramoError('COMMERCIAL_POLICY_UNAVAILABLE', 'no valid ACTIVE commercial policy', 503, { requestId, details: { reason: err.reason } });
  }
  if (err instanceof CommercialCatalogError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return new AramoError('NOT_FOUND', err.message, 404, { requestId, details: err.details });
      case 'NOT_HUMAN':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'not_human' } });
      case 'SCOPE_MISSING':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'scope_missing', ...err.details } });
      case 'INVALID_INPUT':
        return new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: err.details });
      case 'CONFLICT':
        return new AramoError('COMMERCIAL_CATALOG_CONFLICT', err.message, 409, { requestId, details: err.details });
    }
  }
  return err;
}

function actorOf(auth: AuthContextType): CommercialActor {
  return { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes };
}

function ctxOf(requestId: string): CommercialCallContext {
  return { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId };
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function summaryDto(v: CatalogVersionSummary): CatalogVersionSummaryDto {
  return {
    id: v.id,
    plan_id: v.plan_id,
    version_number: v.version_number,
    status: v.status,
    content_checksum: v.content_checksum,
    note: v.note,
    created_by: v.created_by,
    created_at: v.created_at.toISOString(),
    published_at: iso(v.published_at),
    retired_at: iso(v.retired_at),
    terms: { ...v.terms },
    pinned_subscriptions: v.pinned_subscriptions,
    open_requests: v.open_requests.map((r) => ({ id: r.id, action_type: r.action_type, state: r.state, expires_at: iso(r.expires_at) })),
  };
}
