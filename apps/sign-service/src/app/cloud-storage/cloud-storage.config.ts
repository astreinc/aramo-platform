import { CLOUD_PROVIDERS, CLOUD_PROVIDER_FEATURE_KEYS, type CloudProviderId } from '@aramo/sign-client';
import type { OAuthClientCredentials } from '@aramo/sign-cloud-storage';

import { cloudTokenKeyAvailable } from './cloud-token-crypto.js';

// SIGN-FREE-PARITY-1 S6 — when a provider is offered. ALL of:
//   1. its launch key (sign.cloud_<provider>) is AVAILABLE (libs/subscription; NOT_AVAILABLE
//      until the PO authorizes it),
//   2. its OAuth app is configured: SIGN_CLOUD_<PROVIDER>_CLIENT_ID and _CLIENT_SECRET,
//   3. SIGN_CLOUD_TOKEN_KEY is set (tokens can be stored encrypted),
//   4. the public base the provider redirects back to is known: SIGN_CLOUD_REDIRECT_BASE_URL,
//      else ARAMO_SIGN_BASE_URL, else SIGN_WEB_BASE_URL (https://sign.aramo.ai).
// Every route checks the same rule; the sender context reports the same list.

export const CLOUD_ENV_PREFIX: Readonly<Record<CloudProviderId, string>> = {
  google_drive: 'SIGN_CLOUD_GOOGLE_DRIVE',
  onedrive: 'SIGN_CLOUD_ONEDRIVE',
  dropbox: 'SIGN_CLOUD_DROPBOX',
  box: 'SIGN_CLOUD_BOX',
};

/** Where the Aramo Sign app gets the connect result (its registered URL scheme). */
export const CLOUD_APP_RETURN_URL = 'aramosign://cloud-storage';

const trimmed = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim());

export function cloudCredentials(provider: CloudProviderId, env: NodeJS.ProcessEnv = process.env): OAuthClientCredentials | null {
  const id = trimmed(env[`${CLOUD_ENV_PREFIX[provider]}_CLIENT_ID`]);
  const secret = trimmed(env[`${CLOUD_ENV_PREFIX[provider]}_CLIENT_SECRET`]);
  return id === null || secret === null ? null : { client_id: id, client_secret: secret };
}

/** The public https origin of Aramo Sign (no trailing slash), or null. */
export function cloudRedirectBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = trimmed(env['SIGN_CLOUD_REDIRECT_BASE_URL']) ?? trimmed(env['ARAMO_SIGN_BASE_URL']) ?? trimmed(env['SIGN_WEB_BASE_URL']);
  if (raw === null) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // Providers accept only https redirect URLs (http only for a local stack on localhost).
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return null;
  return `${u.protocol}//${u.host}`;
}

export function cloudCallbackUrl(base: string, provider: CloudProviderId): string {
  return `${base}/v1/sign/sender/cloud-storage/${provider}/callback`;
}

export function cloudProviderOffered(provider: CloudProviderId, isAvailable: (featureKey: string) => boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isAvailable(CLOUD_PROVIDER_FEATURE_KEYS[provider]) && cloudCredentials(provider, env) !== null && cloudTokenKeyAvailable(env) && cloudRedirectBase(env) !== null;
}

/** The providers offered right now, in display order. */
export function offeredCloudProviders(isAvailable: (featureKey: string) => boolean, env: NodeJS.ProcessEnv = process.env): CloudProviderId[] {
  return CLOUD_PROVIDERS.filter((p) => cloudProviderOffered(p, isAvailable, env));
}
