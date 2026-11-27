import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Res, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { EsignSenderBoundary } from '@aramo/identity';
import type { Response } from 'express';

import { envelopeEtag, idempotencyKey, senderHttp } from '../sender/envelope-contracts.js';
import { ESIGN_CREATE_SCOPE, ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';

import { CloudStorageService } from './cloud-storage.service.js';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage on the authenticated sender surface
// (sign.aramo.ai/v1/sign/sender/*, already proxied by nginx; the CSP is unchanged). Every
// route mounts EsignSenderBoundary EXCEPT the OAuth callback: the provider redirects the
// browser there (the Aramo Sign app's in-app browser has no Sign session), so the callback's
// only authority is the single-use, 10-minute state it was issued with (sha256-stored, bound
// to one tenant + user + provider). It answers 302 only, and never with data.
@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class SignCloudStorageController {
  constructor(private readonly cloud: CloudStorageService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }

  @Get('cloud-storage')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.cloud.list(auth));
  }

  @Post('cloud-storage/:provider/connect')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  connect(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('provider') provider: string, @Body() body: { client?: unknown; return_path?: unknown }) {
    return this.run(requestId, () => this.cloud.connect(auth, provider, body, requestId));
  }

  @Get('cloud-storage/:provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    const to = await this.cloud.callback(provider, { code, state, error });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, to);
  }

  @Delete('cloud-storage/:provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  disconnect(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('provider') provider: string) {
    return this.run(requestId, () => this.cloud.disconnect(auth, provider, requestId));
  }

  @Get('cloud-storage/:provider/items')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  items(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('provider') provider: string,
    @Query('folder_id') folder_id?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('folders') folders?: string,
    @Query('include_word') include_word?: string,
  ) {
    return this.run(requestId, () => this.cloud.items(auth, provider, { folder_id, q, cursor, folders, include_word }, requestId));
  }

  // Import: the same answer (and ETag) as POST envelopes/:id/documents.
  @Post('envelopes/:id/documents/cloud-import')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  importFile(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { provider?: unknown; file_id?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.run(requestId, async () => {
      const key = idempotencyKey(idemKey, requestId);
      const out = await this.cloud.importFile(auth, id, body, requestId, { ...(ifMatch !== undefined ? { ifMatch } : {}), ...(key !== undefined ? { idempotencyKey: key } : {}) });
      if (typeof out.revision === 'number') res.setHeader('ETag', envelopeEtag(id, out.revision));
      return out;
    });
  }

  @Post('envelopes/:id/cloud-export')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  exportExecuted(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { provider?: unknown; folder_id?: unknown; include_certificate?: unknown },
  ) {
    return this.run(requestId, () => this.cloud.exportExecuted(auth, id, body, requestId));
  }
}
