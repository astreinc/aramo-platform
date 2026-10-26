import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CONSUMER_HEADER, JwtAuthGuard } from '@aramo/auth';
import type { Request, Response } from 'express';

import {
  NATIVE_CONSUMER,
  NativeAuthService,
  parseNativeTokenRequest,
  parseRefreshTokenBody,
  type NativeCaller,
  type NativeSessionItem,
  type NativeTokenResponse,
} from './native-auth.service.js';

// AUTH-SIGNIN-1 Amendment M-A1 — the native authentication consumer endpoints
// (Aramo Sign mobile). Tokens travel in JSON bodies only, never as cookies;
// every response here is `Cache-Control: no-store` (§3.9). No browser host is
// resolved or simulated on these routes (§3.7): the native context is enforced
// by NativeAuthService instead.

interface RequestWithId extends Request {
  requestId?: string;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

@Controller('auth/native/sign')
export class NativeAuthController {
  constructor(
    private readonly native: NativeAuthService,
    private readonly jwt: JwtAuthGuard,
  ) {}

  @Post('token')
  @HttpCode(200)
  async token(
    @Body() body: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NativeTokenResponse> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    return this.native.exchange(parseNativeTokenRequest(body, requestId), requestId);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NativeTokenResponse> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    return this.native.refresh(parseRefreshTokenBody(body, requestId), requestId);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() body: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    await this.native.logout(parseRefreshTokenBody(body, requestId));
  }

  @Get('sessions')
  async sessions(
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ items: NativeSessionItem[] }> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const caller = await this.authenticate(req, requestId);
    return this.native.listSessions(caller, requestId);
  }

  @Delete('sessions/:device_session_id')
  @HttpCode(204)
  async revoke(
    @Param('device_session_id') deviceSessionId: string,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const caller = await this.authenticate(req, requestId);
    await this.native.revokeSession(caller, deviceSessionId, requestId);
  }

  // Device operations need an authenticated NATIVE Bearer token (never a
  // cookie): verified exactly as a protected route verifies it (signature,
  // issuer, audience, claims, server-side authorization revision), then required
  // to carry the native context for the `sign` consumer.
  private async authenticate(req: RequestWithId, requestId: string): Promise<NativeCaller> {
    const header = req.header('authorization');
    const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);
    if (match === null || match[1] === undefined || match[1].length === 0) {
      throw new AramoError('AUTH_REQUIRED', 'Bearer token required', 401, {
        requestId,
        details: { reason: 'bearer_required' },
      });
    }
    const { context } = await this.jwt.verifyAccessToken(match[1], requestId);
    const declared = req.header(CONSUMER_HEADER);
    if (declared !== undefined && declared !== context.consumer_type) {
      throw new AramoError('INVALID_TOKEN', 'Session consumer does not match the declared consumer', 401, {
        requestId,
        details: { reason: 'consumer_header_mismatch' },
      });
    }
    if (context.client !== 'native' || context.dsid === undefined || context.consumer_type !== NATIVE_CONSUMER) {
      throw new AramoError('INVALID_TOKEN', 'A native sign token is required', 401, {
        requestId,
        details: { reason: 'native_token_required' },
      });
    }
    return { sub: context.sub, tenant_id: context.tenant_id, dsid: context.dsid };
  }
}
