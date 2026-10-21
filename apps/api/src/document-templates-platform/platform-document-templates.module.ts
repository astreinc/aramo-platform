import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { DocumentsModule } from '@aramo/documents';

import { PlatformDocumentTemplatesController } from './platform-document-templates.controller.js';

// DOC-TEMPLATE-LIB-1 T-2 (§6.1) — the platform-tier Aramo default template + variable
// catalog HTTP surface. AuthModule/AuthorizationModule supply JwtAuthGuard + RolesGuard;
// DocumentsModule supplies TemplatesRepository + TemplateVariablesRepository; the
// TEMPLATE_CAPABILITIES port is @Global (TemplateCapabilitiesModule). apps/api already
// depends on @aramo/documents, @aramo/auth and @aramo/authorization — zero new nx edges.
@Module({
  imports: [AuthModule, AuthorizationModule, DocumentsModule],
  controllers: [PlatformDocumentTemplatesController],
})
export class PlatformDocumentTemplatesModule {}
