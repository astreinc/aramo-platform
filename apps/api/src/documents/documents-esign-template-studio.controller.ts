import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { SIGN_TEMPLATE_BODY_DIGEST_PARAM, signTemplateBodyDigest } from '@aramo/documents-contracts';

import { EsignServiceRequestGuard } from '../integrations/sign/esign-service-request.guard.js';

import { SignTemplateStudioService } from './sign-template-studio.service.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the Documents
// template Studio + "Use as it is" endpoints for Aramo Sign, in the SAME signed family as
// DocumentsEsignTemplatesController (EsignServiceRequestGuard, scheme aramo-sign-s2s-v1): only
// sign-service may call them. tenant_id and actor_id (the acting person) are caller-supplied
// signed query parameters; a POST / PATCH body is bound by the signed `body_sha256`.
// SignTemplateStudioService resolves the person's authority from their live role grants.
//
//   GET    v1/documents/esign/templates/library?tenant_id=                     every tenant kind
//   GET    v1/documents/esign/templates/library/:id/preview?tenant_id=
//
//   (PERSONAL tenants only — BUSINESS 403: Org Home owns organization templates)
//   GET    v1/documents/esign/templates/studio?tenant_id=&actor_id=
//   POST   v1/documents/esign/templates/studio/adopt
//   GET    v1/documents/esign/templates/studio/:id            PATCH (rename)
//   GET    v1/documents/esign/templates/studio/:id/versions   POST (new version)
//   POST   v1/documents/esign/templates/studio/:id/draft
//   GET    v1/documents/esign/templates/studio/:id/allowed-bindings
//   PATCH  v1/documents/esign/templates/studio/versions/:versionId      DELETE (discard draft)
//   POST   v1/documents/esign/templates/studio/versions/:versionId/preview
//   POST   v1/documents/esign/templates/studio/versions/:versionId/activate  ("Use this version")

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(message: string, requestId: string, field: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { field } });
}

function uuid(v: unknown, field: string, requestId: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(`${field} must be a uuid`, requestId, field);
  return v;
}

// The received body must hash to the signed body_sha256.
function assertBodyDigest(body: unknown, digest: unknown, requestId: string): void {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw bad(`${SIGN_TEMPLATE_BODY_DIGEST_PARAM} is required`, requestId, SIGN_TEMPLATE_BODY_DIGEST_PARAM);
  }
  if (signTemplateBodyDigest(body ?? {}) !== digest) {
    throw new AramoError('AUTH_REQUIRED', 'sign-service request body does not match its signed digest', 401, { requestId });
  }
}

function obj(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

@Controller('v1/documents/esign/templates/library')
@UseGuards(EsignServiceRequestGuard)
export class DocumentsEsignTemplateGalleryController {
  constructor(private readonly studio: SignTemplateStudioService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  gallery(@Query('tenant_id') tenantId: string, @RequestId() requestId: string) {
    return this.studio.gallery({ tenant_id: uuid(tenantId, 'tenant_id', requestId), requestId });
  }

  @Get(':id/preview')
  @HttpCode(HttpStatus.OK)
  preview(@Param('id') id: string, @Query('tenant_id') tenantId: string, @RequestId() requestId: string) {
    return this.studio.galleryPreview({ tenant_id: uuid(tenantId, 'tenant_id', requestId), template_id: uuid(id, 'id', requestId), requestId });
  }

}

@Controller('v1/documents/esign/templates/studio')
@UseGuards(EsignServiceRequestGuard)
export class DocumentsEsignTemplateStudioController {
  constructor(private readonly studio: SignTemplateStudioService) {}

  private who(tenantId: unknown, actorId: unknown, requestId: string) {
    return { tenant_id: uuid(tenantId, 'tenant_id', requestId), actor_id: uuid(actorId, 'actor_id', requestId), requestId };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Query('tenant_id') tenantId: string, @Query('actor_id') actorId: string, @RequestId() requestId: string) {
    return this.studio.studioList(this.who(tenantId, actorId, requestId));
  }

  @Post('adopt')
  @HttpCode(HttpStatus.CREATED)
  adopt(
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.studio.adopt({ ...who, library_template_id: uuid(obj(body)['library_template_id'], 'library_template_id', requestId) });
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  get(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_id') actorId: string, @RequestId() requestId: string) {
    return this.studio.get({ ...this.who(tenantId, actorId, requestId), template_id: uuid(id, 'id', requestId) });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  rename(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.studio.rename({ ...who, template_id: uuid(id, 'id', requestId), name: obj(body)['name'] });
  }

  @Get(':id/versions')
  @HttpCode(HttpStatus.OK)
  versions(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_id') actorId: string, @RequestId() requestId: string) {
    return this.studio.listVersions({ ...this.who(tenantId, actorId, requestId), template_id: uuid(id, 'id', requestId) });
  }

  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  createVersion(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    const b = obj(body);
    return this.studio.createVersion({ ...who, template_id: uuid(id, 'id', requestId), body: { render_schema_version: b['render_schema_version'], field_schema: b['field_schema'] } });
  }

  @Post(':id/draft')
  @HttpCode(HttpStatus.CREATED)
  draft(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.studio.createDraft({ ...who, template_id: uuid(id, 'id', requestId) });
  }

  @Get(':id/allowed-bindings')
  @HttpCode(HttpStatus.OK)
  allowedBindings(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_id') actorId: string, @RequestId() requestId: string) {
    return this.studio.allowedBindings({ ...this.who(tenantId, actorId, requestId), template_id: uuid(id, 'id', requestId) });
  }

  @Patch('versions/:versionId')
  @HttpCode(HttpStatus.OK)
  updateVersion(
    @Param('versionId') versionId: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.studio.updateVersion({ ...who, version_id: uuid(versionId, 'versionId', requestId), body: obj(body) });
  }

  @Delete('versions/:versionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(@Param('versionId') versionId: string, @Query('tenant_id') tenantId: string, @Query('actor_id') actorId: string, @RequestId() requestId: string): Promise<void> {
    await this.studio.discardDraft({ ...this.who(tenantId, actorId, requestId), version_id: uuid(versionId, 'versionId', requestId) });
  }

  @Post('versions/:versionId/preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('versionId') versionId: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.studio.previewVersion({ ...who, version_id: uuid(versionId, 'versionId', requestId) });
  }

  @Post('versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('versionId') versionId: string,
    @Query('tenant_id') tenantId: string,
    @Query('actor_id') actorId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const who = this.who(tenantId, actorId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.studio.activate({ ...who, version_id: uuid(versionId, 'versionId', requestId) });
  }
}
