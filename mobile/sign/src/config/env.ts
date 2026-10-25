// Runtime configuration. Production defaults are compiled in; development builds may
// override them with EXPO_PUBLIC_* variables (inlined by babel-preset-expo at bundle
// time). Nothing here is secret: the native Cognito client is public (M-A1 §3.1).
//
//   EXPO_PUBLIC_ARAMO_API_BASE_URL     default https://sign.aramo.ai
//   EXPO_PUBLIC_SIGN_COGNITO_DOMAIN    Cognito hosted-UI domain (host only), no default
//   EXPO_PUBLIC_SIGN_NATIVE_CLIENT_ID  the aramo-sign-native app client id, no default
//   EXPO_PUBLIC_SIGN_ANDROID_REDIRECT  'https' (default) | 'custom' (App Links unverified)
//
// Release builds refuse any non-https API origin; only __DEV__ builds may point at a
// local http origin (e.g. an emulator reaching the local stack).

export const SIGN_HOST = 'sign.aramo.ai';
export const PRODUCTION_API_BASE_URL = `https://${SIGN_HOST}`;
/** Verified app-link callback (primary) and custom-scheme fallback, M-A1 §3.1. */
export const NATIVE_REDIRECT_URI = `https://${SIGN_HOST}/auth/native/callback`;
export const NATIVE_FALLBACK_REDIRECT_URI = 'aramosign://auth/callback';

export interface AppEnv {
  readonly apiBaseUrl: string;
  readonly cognitoDomain: string | null;
  readonly nativeClientId: string | null;
  readonly androidRedirect: 'https' | 'custom';
  readonly isDev: boolean;
}

export interface RawEnv {
  readonly EXPO_PUBLIC_ARAMO_API_BASE_URL?: string | undefined;
  readonly EXPO_PUBLIC_SIGN_COGNITO_DOMAIN?: string | undefined;
  readonly EXPO_PUBLIC_SIGN_NATIVE_CLIENT_ID?: string | undefined;
  readonly EXPO_PUBLIC_SIGN_ANDROID_REDIRECT?: string | undefined;
}

const HOST_ONLY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function apiBaseFrom(raw: string | undefined, isDev: boolean): string {
  const value = raw?.trim().replace(/\/+$/, '');
  if (!value) return PRODUCTION_API_BASE_URL;
  if (/^https:\/\/[^/?#@]+$/i.test(value)) return value;
  if (isDev && /^http:\/\/[^/?#@]+$/i.test(value)) return value;
  throw new Error('EXPO_PUBLIC_ARAMO_API_BASE_URL must be an https origin');
}

export function resolveEnv(raw: RawEnv, isDev: boolean): AppEnv {
  const domain = raw.EXPO_PUBLIC_SIGN_COGNITO_DOMAIN?.trim() ?? '';
  const clientId = raw.EXPO_PUBLIC_SIGN_NATIVE_CLIENT_ID?.trim() ?? '';
  return {
    apiBaseUrl: apiBaseFrom(raw.EXPO_PUBLIC_ARAMO_API_BASE_URL, isDev),
    cognitoDomain: HOST_ONLY.test(domain) ? domain.toLowerCase() : null,
    nativeClientId: /^[A-Za-z0-9]{1,128}$/.test(clientId) ? clientId : null,
    androidRedirect: raw.EXPO_PUBLIC_SIGN_ANDROID_REDIRECT === 'custom' ? 'custom' : 'https',
    isDev,
  };
}

// Each EXPO_PUBLIC_* reference must be a literal member access for the bundler to inline it.
export const env: AppEnv = resolveEnv(
  {
    EXPO_PUBLIC_ARAMO_API_BASE_URL: process.env.EXPO_PUBLIC_ARAMO_API_BASE_URL,
    EXPO_PUBLIC_SIGN_COGNITO_DOMAIN: process.env.EXPO_PUBLIC_SIGN_COGNITO_DOMAIN,
    EXPO_PUBLIC_SIGN_NATIVE_CLIENT_ID: process.env.EXPO_PUBLIC_SIGN_NATIVE_CLIENT_ID,
    EXPO_PUBLIC_SIGN_ANDROID_REDIRECT: process.env.EXPO_PUBLIC_SIGN_ANDROID_REDIRECT,
  },
  typeof __DEV__ !== 'undefined' ? __DEV__ : false,
);

/** Public web pages opened in the system browser (handoff §4.1 footer, §4.9 About). */
export const WEB_LINKS = {
  terms: `${PRODUCTION_API_BASE_URL}/legal/terms`,
  privacy: `${PRODUCTION_API_BASE_URL}/legal/privacy`,
  help: `${PRODUCTION_API_BASE_URL}/help`,
} as const;
