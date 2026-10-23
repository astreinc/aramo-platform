import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Post, Res } from '@nestjs/common';
import { ServiceTokenError, ServiceTokenService } from '@aramo/intelligence-core';
import type { ServiceTokenResponse } from '@aramo/intelligence-contracts';

// ATI-SEP-1 T2 (ADR-0036 §3 E-2) — POST /v1/oauth/token, grant_type=client_credentials.
// Accepts form-encoded or JSON bodies, and client credentials either in the body
// or as HTTP Basic. Errors follow the OAuth 2.0 shape { error, error_description }.

const STATUS: Record<string, HttpStatus> = {
  invalid_request: HttpStatus.BAD_REQUEST,
  unsupported_grant_type: HttpStatus.BAD_REQUEST,
  invalid_scope: HttpStatus.BAD_REQUEST,
  invalid_client: HttpStatus.UNAUTHORIZED,
  server_misconfigured: HttpStatus.SERVICE_UNAVAILABLE,
};

function basicCredentials(header: string | undefined): { client_id?: string; client_secret?: string } {
  const m = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!m) return {};
  const decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return {};
  return { client_id: decodeURIComponent(decoded.slice(0, i)), client_secret: decodeURIComponent(decoded.slice(i + 1)) };
}

@Controller('v1/oauth')
export class OAuthTokenController {
  constructor(private readonly tokens: ServiceTokenService) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async token(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ): Promise<ServiceTokenResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const basic = basicCredentials(authorization);
    try {
      return await this.tokens.exchange({
        grant_type: b['grant_type'],
        client_id: basic.client_id ?? b['client_id'],
        client_secret: basic.client_secret ?? b['client_secret'],
        scope: b['scope'],
      });
    } catch (err) {
      if (err instanceof ServiceTokenError) {
        throw new HttpException(
          { error: err.code === 'server_misconfigured' ? 'temporarily_unavailable' : err.code, error_description: err.message },
          STATUS[err.code] ?? HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }
}
