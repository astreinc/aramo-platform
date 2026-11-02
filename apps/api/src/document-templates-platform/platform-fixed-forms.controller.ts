import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { templateErrorToHttp } from '@aramo/documents';

import { FixedFormService, toFieldView } from '../documents/fixed-form.service.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.1, §7.2 — Platform Admin
// authoring of an Aramo fixed legal form (a default of a FIXED_FORM document type): upload
// the official PDF, place fields over it by signer role, check it (the §18 preview), then
// publish / withdraw through the shared default routes (PlatformDocumentTemplatesController:
// TP-1 tag-required check and the TP-3 type-subset rule apply unchanged).
//
//   POST /platform/document-templates/:id/fixed-form/draft               open a DRAFT (copies the
//                                                                         current version's PDF + fields)
//   GET  /platform/document-templates/versions/:versionId/fixed-form      the Studio view (content,
//                                                                         fields, variables, issues)
//   PUT  /platform/document-templates/versions/:versionId/fixed-form/pdf  upload the PDF (base64 JSON)
//   GET  /platform/document-templates/versions/:versionId/fixed-form/pdf  the PDF (base64 JSON)
//   PUT  /platform/document-templates/versions/:versionId/fixed-form/layout  roles + title + every field
//   POST /platform/document-templates/versions/:versionId/fields         add ONE field (mirrors the
//                                                                         tenant POST versions/:versionId/fields)
//   GET  /platform/document-templates/versions/:versionId/fields         the placed fields
//   POST /platform/document-templates/versions/:versionId/fixed-form/preview  validate + record preview
//
// AuthZ mirrors PlatformDocumentTemplatesController: JwtAuthGuard + RolesGuard, reads
// platform:document_template:read, writes :manage, consumer_type === 'platform' asserted per
// route. Served by apps/api under the existing /platform/document-templates edge prefix.

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformFixedFormsController {
  constructor(private readonly forms: FixedFormService) {}

  @Post('document-templates/:id/fixed-form/draft')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:document_template:manage')
  async createDraft(@Param('id', ParseUUIDPipe) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => {
      const draft = await this.forms.createDraft(id, auth.sub, requestId);
      return this.forms.platformView(draft.id, requestId);
    });
  }

  @Get('document-templates/versions/:versionId/fixed-form')
  @RequireScopes('platform:document_template:read')
  async view(@Param('versionId', ParseUUIDPipe) versionId: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, () => this.forms.platformView(versionId, requestId));
  }

  // The body is JSON { content_base64 } (the 10 MB PDF is ~13.4 MB as base64; apps/api main.ts
  // mounts a route-scoped JSON parser with a 15 MB limit for this path only).
  @Put('document-templates/versions/:versionId/fixed-form/pdf')
  @RequireScopes('platform:document_template:manage')
  async uploadPdf(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    const raw = body?.['content_base64'];
    if (typeof raw !== 'string' || raw.length === 0 || !BASE64_RE.test(raw)) {
      throw new AramoError('VALIDATION_ERROR', 'content_base64 (the PDF, base64) is required', 400, { requestId, details: { reason: 'content_required' } });
    }
    return this.run(requestId, async () => {
      await this.forms.uploadPdf({ version_id: versionId, bytes: new Uint8Array(Buffer.from(raw, 'base64')), actor: auth.sub, requestId });
      return this.forms.platformView(versionId, requestId);
    });
  }

  @Get('document-templates/versions/:versionId/fixed-form/pdf')
  @RequireScopes('platform:document_template:read')
  async pdf(@Param('versionId', ParseUUIDPipe) versionId: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => {
      const view = await this.forms.platformView(versionId, requestId);
      const pdf = view.content.pdf;
      if (pdf === null) {
        throw new AramoError('TEMPLATE_VERSION_NOT_FOUND', 'no PDF has been uploaded to this version', 404, { requestId, details: { reason: 'pdf_missing' } });
      }
      const bytes = await this.forms.readPdf(pdf, requestId);
      return { sha256: pdf.sha256, byte_size: bytes.byteLength, content_base64: bytes.toString('base64') };
    });
  }

  @Put('document-templates/versions/:versionId/fixed-form/layout')
  @RequireScopes('platform:document_template:manage')
  async saveLayout(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    if (body === undefined || body === null || typeof body !== 'object' || (!('signing' in body) && !('fields' in body) && !('title' in body))) {
      throw new AramoError('VALIDATION_ERROR', 'one of signing, fields, title is required', 400, { requestId });
    }
    return this.run(requestId, async () => {
      await this.forms.saveLayout({ version_id: versionId, body, requestId });
      return this.forms.platformView(versionId, requestId);
    });
  }

  @Post('document-templates/versions/:versionId/fields')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:document_template:manage')
  async addField(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => toFieldView(await this.forms.addField({ version_id: versionId, body, requestId })));
  }

  @Get('document-templates/versions/:versionId/fields')
  @RequireScopes('platform:document_template:read')
  async listFields(@Param('versionId', ParseUUIDPipe) versionId: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => ({ fields: (await this.forms.platformView(versionId, requestId)).fields }));
  }

  @Post('document-templates/versions/:versionId/fixed-form/preview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:document_template:manage')
  async preview(@Param('versionId', ParseUUIDPipe) versionId: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, () => this.forms.preview(versionId, requestId));
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
