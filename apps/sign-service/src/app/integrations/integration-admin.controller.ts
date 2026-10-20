import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';

import { IntegrationAdminService, type InstallBody } from './integration-admin.service.js';

// Sign Unified Product S-4 — installation administration in the Sign workspace
// (/v1/sign/sender/integrations/*). Every route mounts the sender boundary
// (esign consumer → tenant `sign` capability) with sign:integration:manage
// (Sign Admin / Owner).
@Controller('v1/sign/sender/integrations')
@UseFilters(AramoExceptionFilter)
export class IntegrationAdminController {
  constructor(private readonly admin: IntegrationAdminService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.admin.list(auth, requestId));
  }

  @Post('installations')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  install(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: InstallBody) {
    return this.run(requestId, () => this.admin.install(auth, body ?? {}, requestId));
  }

  @Patch('installations/:id')
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  update(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: InstallBody) {
    return this.run(requestId, () => this.admin.update(auth, id, body ?? {}, requestId));
  }

  @Post('installations/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  revoke(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.admin.revoke(auth, id, requestId));
  }

  @Post('installations/:id/credentials')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  createCredential(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.admin.createCredential(auth, id, requestId));
  }

  @Post('installations/:id/credentials/:credentialId/revoke')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  revokeCredential(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('credentialId') credentialId: string) {
    return this.run(requestId, () => this.admin.revokeCredential(auth, id, credentialId, requestId));
  }

  @Put('installations/:id/role-mappings')
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  roleMappings(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { mappings?: unknown }) {
    return this.run(requestId, () => this.admin.setRoleMappings(auth, id, body ?? {}, requestId));
  }

  // Sign Unified Product S-5 — webhook subscriptions of an installation.
  @Get('installations/:id/webhooks')
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  listWebhooks(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.admin.listWebhooks(auth, id, requestId));
  }

  @Post('installations/:id/webhooks')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  createWebhook(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { target_url?: unknown; event_types?: unknown }) {
    return this.run(requestId, () => this.admin.createWebhook(auth, id, body ?? {}, requestId));
  }

  @Post('installations/:id/webhooks/:webhookId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  rotateWebhookSecret(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('webhookId') webhookId: string) {
    return this.run(requestId, () => this.admin.rotateWebhookSecret(auth, id, webhookId, requestId));
  }

  @Post('installations/:id/webhooks/:webhookId/disable')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  disableWebhook(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('webhookId') webhookId: string) {
    return this.run(requestId, () => this.admin.setWebhookStatus(auth, id, webhookId, 'DISABLED', requestId));
  }

  @Post('installations/:id/webhooks/:webhookId/enable')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.INTEGRATION_MANAGE)
  enableWebhook(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('webhookId') webhookId: string) {
    return this.run(requestId, () => this.admin.setWebhookStatus(auth, id, webhookId, 'ACTIVE', requestId));
  }
}
