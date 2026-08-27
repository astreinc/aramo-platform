// CB-D2-FG — SAP Fieldglass credential codec (vendor-specific; lives under
// provider/fieldglass/, OUTSIDE the provider-neutrality scan — SAP/Fieldglass
// vocabulary is legal here). Mirrors COMM-B3 `ZoomCredentialBundle`: the OAuth2
// client-credentials material is stored as ONE opaque credential string in the
// existing integration Secrets Manager substrate (IntegrationConnection.secret_ref).
// This codec gives the adapter a TYPED shape over that opaque string; it does NOT
// resolve, read, or persist the secret — the PRODUCER resolves it server-side and
// hands the adapter an already-resolved ephemeral string (R-CREDENTIAL).
//
// Secret-vs-config split (directive §Implementation-seams 1): the OAuth client
// credentials are SECRET and travel in THIS bundle; non-secret endpoint config
// (base URL, connector name) lives in IntegrationConnection.config, NOT here.
//   - client_id      — the OAuth client id (classified confidential; bundled).
//   - client_secret  — the OAuth client secret (always secret).
//   - application_key — the SAP Fieldglass application/API key (a shared
//                       credential; classified secret, so it rides the bundle).

export interface FieldglassCredentialBundle {
  readonly client_id: string;
  readonly client_secret: string;
  /** The SAP Fieldglass application/API key, when the tenant's integration uses one. */
  readonly application_key?: string;
}

export class FieldglassCredentialDecodeError extends Error {
  constructor(detail: string) {
    super(`invalid fieldglass credential bundle: ${detail}`);
    this.name = 'FieldglassCredentialDecodeError';
  }
}

/** Encode a bundle to the opaque credential string stored in Secrets Manager. */
export function encodeFieldglassCredential(bundle: FieldglassCredentialBundle): string {
  if (bundle.client_id.length === 0) {
    throw new FieldglassCredentialDecodeError('client_id is empty');
  }
  if (bundle.client_secret.length === 0) {
    throw new FieldglassCredentialDecodeError('client_secret is empty');
  }
  return JSON.stringify(bundle);
}

/** Decode the opaque credential string back to a typed bundle (parse + validate). */
export function decodeFieldglassCredential(raw: string): FieldglassCredentialBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldglassCredentialDecodeError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FieldglassCredentialDecodeError('not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['client_id'] !== 'string' || obj['client_id'].length === 0) {
    throw new FieldglassCredentialDecodeError('missing client_id');
  }
  if (typeof obj['client_secret'] !== 'string' || obj['client_secret'].length === 0) {
    throw new FieldglassCredentialDecodeError('missing client_secret');
  }
  return {
    client_id: obj['client_id'],
    client_secret: obj['client_secret'],
    ...(typeof obj['application_key'] === 'string' ? { application_key: obj['application_key'] } : {}),
  };
}
