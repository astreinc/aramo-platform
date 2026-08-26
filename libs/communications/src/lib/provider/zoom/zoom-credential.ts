// COMM-B3 — Zoom Phone credential codec (vendor-specific; lives under
// provider/zoom/, OUTSIDE the provider-neutrality scan). Per the OAuth ruling
// (opaque-credential storage, NOT an authorization-code flow): the Zoom OAuth
// token bundle is stored as ONE opaque credential string in the existing
// integration Secrets Manager substrate (IntegrationConnection.secret_ref). This
// codec gives the adapter a TYPED shape over that opaque string; it does NOT
// perform token refresh or any live Zoom call — those are deferred (B8).

export interface ZoomCredentialBundle {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  /** ISO-8601 expiry of access_token, if known. */
  readonly expires_at?: string;
  /** The Zoom account id this bundle authorizes (provider account identity). */
  readonly account_id?: string;
}

export class ZoomCredentialDecodeError extends Error {
  constructor(detail: string) {
    super(`invalid zoom credential bundle: ${detail}`);
    this.name = 'ZoomCredentialDecodeError';
  }
}

/** Encode a bundle to the opaque credential string stored in Secrets Manager. */
export function encodeZoomCredential(bundle: ZoomCredentialBundle): string {
  if (bundle.access_token.length === 0) {
    throw new ZoomCredentialDecodeError('access_token is empty');
  }
  return JSON.stringify(bundle);
}

/** Decode the opaque credential string back to a typed bundle (parse + validate). */
export function decodeZoomCredential(raw: string): ZoomCredentialBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ZoomCredentialDecodeError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ZoomCredentialDecodeError('not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['access_token'] !== 'string' || obj['access_token'].length === 0) {
    throw new ZoomCredentialDecodeError('missing access_token');
  }
  const out: ZoomCredentialBundle = {
    access_token: obj['access_token'],
    ...(typeof obj['refresh_token'] === 'string' ? { refresh_token: obj['refresh_token'] } : {}),
    ...(typeof obj['token_type'] === 'string' ? { token_type: obj['token_type'] } : {}),
    ...(typeof obj['scope'] === 'string' ? { scope: obj['scope'] } : {}),
    ...(typeof obj['expires_at'] === 'string' ? { expires_at: obj['expires_at'] } : {}),
    ...(typeof obj['account_id'] === 'string' ? { account_id: obj['account_id'] } : {}),
  };
  return out;
}
