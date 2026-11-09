import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import type { Response } from 'express';

import { RecipientInboxBoundary } from '../../inbox/recipient-inbox.controller.js';

import { safeReturnPath, SignAppleRevokeService, withRevokedFlag } from './sign-apple-revoke.service.js';

// Apple Go-Live R-8 / W6 — Apple token revocation on account deletion (best effort).
//   POST /v1/sign/me/apple/revoke            signed-in (session + sign consumer, like /v1/sign/me/*);
//                                            {authorization_code, client: 'ios'|'web'} → 202 {} always
//   GET  /v1/sign/me/apple/revoke/start      signed-in; ?return=<relative path> → 302 to Apple authorize
//                                            (unconfigured → 302 straight to <return>?apple_revoked=0)
//   POST /v1/sign/me/apple/revoke/callback   NO session: Apple's cross-site form_post (code, state); the
//                                            user and return path come from the signed state only
//                                            → 302 <return>?apple_revoked=1|0
@Controller('v1/sign/me/apple/revoke')
@UseFilters(AramoExceptionFilter)
export class SignAppleRevokeController {
  constructor(private readonly apple: SignAppleRevokeService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RecipientInboxBoundary()
  async revoke(@Body() body: { authorization_code?: unknown; client?: unknown }): Promise<Record<string, never>> {
    await this.apple.revokeFromApp(body ?? {});
    return {};
  }

  @Get('start')
  @RecipientInboxBoundary()
  start(
    @AuthContext() auth: AuthContextType,
    @Query('return') ret: unknown,
    @Query('format') format: unknown,
    @RequestId() requestId: string,
    @Res() res: Response,
  ): void {
    const returnPath = safeReturnPath(ret);
    if (returnPath === null) {
      throw new AramoError('VALIDATION_ERROR', 'return must be a relative path', 400, { requestId, details: { reason: 'invalid_return' } });
    }
    const url = this.apple.authorizeUrl(auth.sub, returnPath);
    // The Android app holds a Bearer token a browser tab cannot send: `format=json` returns the
    // authorize URL (null when unconfigured) for the app to open itself.
    if (format === 'json') {
      res.status(HttpStatus.OK).json({ url: url ?? null });
      return;
    }
    res.redirect(HttpStatus.FOUND, url ?? withRevokedFlag(returnPath, false));
  }

  @Post('callback')
  async callback(@Body() body: { code?: unknown; state?: unknown }, @Res() res: Response): Promise<void> {
    res.redirect(HttpStatus.FOUND, await this.apple.callback(body ?? {}));
  }
}
