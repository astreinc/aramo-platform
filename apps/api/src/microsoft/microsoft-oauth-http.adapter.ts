import { Injectable } from '@nestjs/common';
import {
  MicrosoftConsentRevokedError,
  buildMicrosoftTokenEndpoint,
  type AuthorizationCodeExchangeArgs,
  type MicrosoftOAuthPort,
  type MicrosoftTokenExchangeResult,
  type RefreshArgs,
} from '@aramo/microsoft-graph';

// COMM-C2B — Microsoft token endpoint adapter (R2/R3/R4). Server-side only:
// performs the authorization-code exchange and refresh over HTTPS. Tokens are
// returned to the orchestrator for secret-store custody and NEVER logged. A
// refresh rejected with invalid_grant surfaces as MicrosoftConsentRevokedError
// so the identity flips to reauthorization-required (R4/R19).

interface MsTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function decodeIdTokenClaims(idToken: string): { tid: string; oid: string } {
  const parts = idToken.split('.');
  if (parts.length < 2 || parts[1] === undefined) {
    return { tid: '', oid: '' };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      tid?: string;
      oid?: string;
      sub?: string;
    };
    return { tid: payload.tid ?? '', oid: payload.oid ?? payload.sub ?? '' };
  } catch {
    return { tid: '', oid: '' };
  }
}

@Injectable()
export class MicrosoftOAuthHttpAdapter implements MicrosoftOAuthPort {
  async exchangeAuthorizationCode(
    args: AuthorizationCodeExchangeArgs,
  ): Promise<MicrosoftTokenExchangeResult> {
    const body = new URLSearchParams({
      client_id: args.clientId,
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    });
    if (args.clientSecret !== undefined && args.clientSecret.length > 0) {
      body.set('client_secret', args.clientSecret);
    }
    return this.post(buildMicrosoftTokenEndpoint(args.authorityTenant), body, false);
  }

  async refresh(args: RefreshArgs): Promise<MicrosoftTokenExchangeResult> {
    const body = new URLSearchParams({
      client_id: args.clientId,
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
    });
    if (args.clientSecret !== undefined && args.clientSecret.length > 0) {
      body.set('client_secret', args.clientSecret);
    }
    return this.post(buildMicrosoftTokenEndpoint(args.authorityTenant), body, true);
  }

  private async post(
    url: string,
    body: URLSearchParams,
    isRefresh: boolean,
  ): Promise<MicrosoftTokenExchangeResult> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as MsTokenResponse;
    if (!res.ok || json.access_token === undefined) {
      if (isRefresh && (json.error === 'invalid_grant' || res.status === 400)) {
        throw new MicrosoftConsentRevokedError(json.error_description ?? 'microsoft refresh rejected');
      }
      // Never echo tokens; error text is provider-supplied error codes only.
      throw new Error(`microsoft token endpoint error: ${json.error ?? String(res.status)}`);
    }
    const claims = json.id_token !== undefined ? decodeIdTokenClaims(json.id_token) : { tid: '', oid: '' };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? '',
      expires_in: json.expires_in ?? 3600,
      token_type: json.token_type ?? 'Bearer',
      scope: json.scope ?? '',
      ms_tenant_id: claims.tid,
      ms_object_id: claims.oid,
    };
  }
}
