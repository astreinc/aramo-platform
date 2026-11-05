// Aramo Sign Mobile M-A12 W1-G item 7 (LOCKED) — store billing is DARK by default. Every value
// comes from the environment with NO default: an unset value turns the feature (or that store) off.
// Secrets (the In-App Purchase key, the Play service-account credentials) are never logged.
//
//   SIGN_STORE_BILLING_ENABLED            exactly '1' enables the store routes
//   SIGN_APPLE_IAP_ISSUER_ID              App Store Connect API issuer id (uuid)
//   SIGN_APPLE_IAP_KEY_ID                 In-App Purchase key id
//   SIGN_APPLE_IAP_PRIVATE_KEY_B64        base64 of the In-App Purchase key (.p8, PKCS#8 PEM)
//   SIGN_APPLE_BUNDLE_ID                  the app bundle id (ai.aramo.sign)
//   SIGN_APPLE_ENVIRONMENT                Sandbox | Production
//   SIGN_GOOGLE_PLAY_PACKAGE              the Play package name (ai.aramo.sign)
//   SIGN_GOOGLE_PLAY_CREDENTIALS_B64      base64 of the Play Developer API service-account JSON key
//   SIGN_GOOGLE_PLAY_RTDN_AUDIENCE        the OIDC audience configured on the Pub/Sub push subscription
//   SIGN_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT the service account Pub/Sub signs the push token as

export type AppleEnvironment = 'Sandbox' | 'Production';

export interface AppleStoreConfig {
  issuer_id: string;
  key_id: string;
  private_key_pem: string;
  bundle_id: string;
  environment: AppleEnvironment;
}

export interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

export interface GooglePlayConfig {
  package_name: string;
  credentials: GoogleServiceAccountKey;
  rtdn_audience: string | null;
  rtdn_service_account: string | null;
}

const val = (env: NodeJS.ProcessEnv, k: string): string | null => {
  const v = env[k]?.trim();
  return v === undefined || v === '' ? null : v;
};

/** SIGN_STORE_BILLING_ENABLED — only exactly `1` enables (dark default). */
export function storeBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_STORE_BILLING_ENABLED']?.trim() === '1';
}

function decodeB64(v: string): string | null {
  try {
    const out = Buffer.from(v, 'base64').toString('utf8');
    return out.trim() === '' ? null : out;
  } catch {
    return null;
  }
}

/** The App Store configuration, or null when any value is missing or malformed (Apple off). */
export function appleStoreConfig(env: NodeJS.ProcessEnv = process.env): AppleStoreConfig | null {
  const issuer_id = val(env, 'SIGN_APPLE_IAP_ISSUER_ID');
  const key_id = val(env, 'SIGN_APPLE_IAP_KEY_ID');
  const keyB64 = val(env, 'SIGN_APPLE_IAP_PRIVATE_KEY_B64');
  const bundle_id = val(env, 'SIGN_APPLE_BUNDLE_ID');
  const environment = val(env, 'SIGN_APPLE_ENVIRONMENT');
  if (issuer_id === null || key_id === null || keyB64 === null || bundle_id === null) return null;
  if (environment !== 'Sandbox' && environment !== 'Production') return null;
  const private_key_pem = decodeB64(keyB64);
  if (private_key_pem === null || !private_key_pem.includes('PRIVATE KEY')) return null;
  return { issuer_id, key_id, private_key_pem, bundle_id, environment };
}

/** The Google Play configuration, or null when the package or credentials are missing (Play off). */
export function googlePlayConfig(env: NodeJS.ProcessEnv = process.env): GooglePlayConfig | null {
  const package_name = val(env, 'SIGN_GOOGLE_PLAY_PACKAGE');
  const credB64 = val(env, 'SIGN_GOOGLE_PLAY_CREDENTIALS_B64');
  if (package_name === null || credB64 === null) return null;
  const raw = decodeB64(credB64);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const client_email = typeof o['client_email'] === 'string' ? o['client_email'] : '';
  const private_key = typeof o['private_key'] === 'string' ? o['private_key'] : '';
  if (client_email === '' || !private_key.includes('PRIVATE KEY')) return null;
  return {
    package_name,
    credentials: { client_email, private_key, ...(typeof o['private_key_id'] === 'string' ? { private_key_id: o['private_key_id'] } : {}) },
    rtdn_audience: val(env, 'SIGN_GOOGLE_PLAY_RTDN_AUDIENCE'),
    rtdn_service_account: val(env, 'SIGN_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT'),
  };
}

/** The store subscription-management pages (deep links; no purchase URL). */
export const APPLE_MANAGE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
export function googlePlayManageUrl(package_name: string, product_id: string | null): string {
  const q = new URLSearchParams({ package: package_name, ...(product_id !== null ? { sku: product_id } : {}) });
  return `https://play.google.com/store/account/subscriptions?${q.toString()}`;
}
