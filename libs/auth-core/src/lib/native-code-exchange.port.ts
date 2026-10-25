import { Injectable } from '@nestjs/common';

// AUTH-SIGNIN-1 Amendment M-A1 §3.3 — the authorization-code exchange with
// Cognito for the PUBLIC native app client (no secret; PKCE S256). Behind a
// port so the network call is an adapter: tests bind a fake and never reach
// Cognito. The production adapter below is the same token-endpoint call the
// browser callback makes (SessionOrchestratorService.exchangeCognitoCode),
// parameterised by the native client id and the app's own redirect_uri and
// code_verifier.

export interface NativeCodeExchangeInput {
  code: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
}

// `rejected` — Cognito answered 4xx (invalid_grant: a used/expired code, a PKCE
// verifier mismatch, a redirect_uri that differs from the authorize request).
// A client fault. `unavailable` — network failure, 5xx, or a malformed answer.
export type NativeCodeExchangeResult =
  | { kind: 'ok'; id_token: string }
  | { kind: 'rejected'; oauth_error: string }
  | { kind: 'unavailable'; detail: string };

export const NATIVE_CODE_EXCHANGE = 'NATIVE_CODE_EXCHANGE';

export interface NativeCodeExchange {
  exchange(input: NativeCodeExchangeInput): Promise<NativeCodeExchangeResult>;
}

// OAuth error codes are a closed ASCII vocabulary; anything else is reduced to a
// fixed placeholder so no response text is echoed further.
function oauthErrorOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && /^[a-z_]{1,64}$/.test(parsed.error)) return parsed.error;
  } catch {
    // not JSON
  }
  return 'invalid_grant';
}

@Injectable()
export class CognitoNativeCodeExchangeAdapter implements NativeCodeExchange {
  async exchange(input: NativeCodeExchangeInput): Promise<NativeCodeExchangeResult> {
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    if (domain === undefined || domain.length === 0) {
      return { kind: 'unavailable', detail: 'cognito-domain-missing' };
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.client_id,
      code: input.code,
      redirect_uri: input.redirect_uri,
      code_verifier: input.code_verifier,
    });
    let res: Response;
    try {
      res = await fetch(`https://${domain}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      return { kind: 'unavailable', detail: `network: ${(err as Error).message}` };
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => '');
      return { kind: 'rejected', oauth_error: oauthErrorOf(text) };
    }
    if (!res.ok) {
      return { kind: 'unavailable', detail: `cognito-token-status-${res.status}` };
    }
    const json = (await res.json().catch(() => ({}))) as { id_token?: unknown };
    if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
      return { kind: 'unavailable', detail: 'cognito-token-missing-id-token' };
    }
    // Cognito's own access/refresh tokens are discarded: Aramo brokers its own
    // session (the browser rule, AUTH-SIGNIN-1 / §5 D3 note).
    return { kind: 'ok', id_token: json.id_token };
  }
}
