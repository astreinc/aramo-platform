import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { EsignSenderBoundary } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';

import { DOCUMENT_TEMPLATE_READ_SCOPE } from './sender-context.service.js';
import { SenderTemplateStudioService } from './sender-template-studio.service.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the sender's
// template gallery, "Use as it is" and the Personal Studio. Same authenticated SENDER zone as
// EsignSenderTemplatesController (EsignSenderBoundary: JwtAuthGuard → `sign` consumer → `sign`
// capability → document_template:read); SenderTemplateStudioService applies the template gate
// (launch availability, plan) and the tenant-kind rule; apps/api checks the person's grants.
//
//   GET    v1/sign/sender/templates/library                         gallery (every tenant kind)
//   GET    v1/sign/sender/templates/library/:id/preview
//   GET    v1/sign/sender/templates/studio                          (PERSONAL only, below)
//   POST   v1/sign/sender/templates/studio/adopt
//   GET    v1/sign/sender/templates/studio/:id                      PATCH = rename
//   GET    v1/sign/sender/templates/studio/:id/versions             POST = new version
//   POST   v1/sign/sender/templates/studio/:id/draft
//   GET    v1/sign/sender/templates/studio/:id/allowed-bindings
//   PATCH  v1/sign/sender/templates/studio/versions/:versionId      DELETE = discard the draft
//   POST   v1/sign/sender/templates/studio/versions/:versionId/preview
//   POST   v1/sign/sender/templates/studio/versions/:versionId/activate   "Use this version"
@Controller('v1/sign/sender/templates')
@UseFilters(AramoExceptionFilter)
export class EsignSenderTemplateStudioController {
  constructor(private readonly studio: SenderTemplateStudioService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get('library')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  gallery(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.studio.gallery(auth, requestId));
  }

  @Get('library/:id/preview')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  galleryPreview(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.studio.galleryPreview(auth, id, requestId));
  }

  @Get('studio')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.studio.list(auth, requestId));
  }

  @Post('studio/adopt')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  adopt(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.studio.adopt(auth, body, requestId));
  }

  @Get('studio/:id')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  get(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.studio.get(auth, id, requestId));
  }

  @Patch('studio/:id')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  rename(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.run(requestId, () => this.studio.rename(auth, id, body, requestId));
  }

  @Get('studio/:id/versions')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  versions(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.studio.versions(auth, id, requestId));
  }

  @Post('studio/:id/versions')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  createVersion(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.run(requestId, () => this.studio.createVersion(auth, id, body, requestId));
  }

  @Post('studio/:id/draft')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  createDraft(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.studio.createDraft(auth, id, requestId));
  }

  @Get('studio/:id/allowed-bindings')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  allowedBindings(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.studio.allowedBindings(auth, id, requestId));
  }

  @Patch('studio/versions/:versionId')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  updateVersion(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('versionId') versionId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.studio.updateVersion(auth, versionId, body, requestId));
  }

  @Delete('studio/versions/:versionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  discardDraft(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('versionId') versionId: string) {
    return this.run(requestId, () => this.studio.discardDraft(auth, versionId, requestId));
  }

  @Post('studio/versions/:versionId/preview')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  preview(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('versionId') versionId: string) {
    return this.run(requestId, () => this.studio.preview(auth, versionId, requestId));
  }

  @Post('studio/versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  activate(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('versionId') versionId: string) {
    return this.run(requestId, () => this.studio.activate(auth, versionId, requestId));
  }
}
