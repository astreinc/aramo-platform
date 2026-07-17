import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type { Response } from 'express';

import { PortalRtbfService } from './portal-rtbf.service.js';
import {
  PortalRtbfRequestDto,
  type PortalRtbfResultDto,
} from './dto/portal-rtbf.dto.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCESS_COOKIE = 'aramo_access_token';
const REFRESH_COOKIE = 'aramo_refresh_token';

function shouldSetSecure(): boolean {
  if (process.env['NODE_ENV'] === 'production') return true;
  return process.env['AUTH_ALLOW_INSECURE_COOKIES'] !== 'true';
}

// Portal P4 P4b (Aramo-Portal-P4-Directive-v1_0-LOCKED §PR-2, D-2/D-3) — the talent
// RTBF surface: a signed-in portal user permanently erases their OWN platform
// identity + sign-in.
//
// GATE (Option A, Lead-ruled): the guard stack + capability + the portal asserts,
// with NO @RequireScopes. RTBF is self-service self-deletion — the erasure is keyed
// off the session `sub` only, so a portal user can only ever erase THEMSELVES;
// there is no "some may / some may not" distinction a scope would express. (A
// separate FIX-PORTAL-SCOPES-1 addresses the stale PORTAL_SESSION_SCOPES gap; NOT
// touched here.) Sibling of PortalController (its class guards are unconditional);
// lives in apps/api (the composition root) to compose purgeCluster + portal_identity
// + refresh-token revoke + cookie destruction across libs.
@Controller('v1/portal/rights')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('portal')
export class PortalRightsController {
  constructor(private readonly rtbf: PortalRtbfService) {}

  // POST /v1/portal/rights/erase — erase the caller's own platform identity, then
  // destroy the session (revoke refresh tokens + clear both cookies). Idempotent.
  @Post('erase')
  @HttpCode(HttpStatus.OK)
  async erase(
    @Body() body: PortalRtbfRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalRtbfResultDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    this.assertIdempotencyKey(idempotencyKey, requestId);

    await this.rtbf.eraseSelf({
      portalUserId: sub,
      confirmation: body.confirmation,
      requestId,
    });

    // Session destruction (D-3): drop both HttpOnly cookies immediately (the
    // server-side refresh-token revoke happens inside eraseSelf).
    res.cookie(ACCESS_COOKIE, '', {
      httpOnly: true,
      secure: shouldSetSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    res.cookie(REFRESH_COOKIE, '', {
      httpOnly: true,
      secure: shouldSetSecure(),
      sameSite: 'strict',
      path: '/auth',
      maxAge: 0,
    });

    return { erased: true };
  }

  private assertConsumerIsPortal(
    authContext: AuthContextType,
    requestId: string,
  ): void {
    if (authContext.consumer_type !== 'portal') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'portal endpoints are portal-consumer only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
  }

  private assertSubIsUuid(
    authContext: AuthContextType,
    requestId: string,
  ): string {
    const sub = authContext.sub;
    if (!UUID_REGEX.test(sub)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'portal token sub claim must be a UUID',
        400,
        { requestId, details: { invalid_field: 'sub' } },
      );
    }
    return sub;
  }

  private assertIdempotencyKey(
    key: string | undefined,
    requestId: string,
  ): string {
    if (key === undefined || key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        400,
        { requestId, details: { missing_field: 'Idempotency-Key' } },
      );
    }
    if (!UUID_REGEX.test(key)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a UUID',
        400,
        { requestId, details: { invalid_field: 'Idempotency-Key' } },
      );
    }
    return key;
  }
}
