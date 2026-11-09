// Apple Go-Live R-8 (App Store guideline 5.1.1(v)) — when an Apple-linked Personal account
// is deleted, the app re-authenticates with Apple DIRECTLY (not through Cognito) so
// sign-service can revoke Apple's tokens:
//   iOS:     the native Apple sheet returns an authorization code →
//            POST /v1/sign/me/apple/revoke {authorization_code, client: 'ios'} (202 always);
//   Android: GET /v1/sign/me/apple/revoke/start?return=/&format=json with the Bearer token
//            → {url}; the app opens that Apple authorize URL in the browser; Apple form_posts
//            to sign-service, which revokes and returns to the Sign web home (not caught).
//            A null url means revocation isn't configured on the server: skipped.
// Best effort: every failure (no sheet, cancelled, offline, server) is swallowed and the
// deletion goes ahead. Nothing from Apple is kept on the device.
import type { AppleRevokeRequest, SignInMethod } from '../../api/apple-contract-types';
import type { WorkspaceClient } from '../../api/workspaceClient';

/** Where the Android round trip ends on the Sign web host (harmless; the app ignores it). */
export const APPLE_REVOKE_RETURN = '/';

/** True when the user signs in with Apple (current provider or any linked method). */
export function appleLinked(
  identityProvider: string | null | undefined,
  methods: readonly SignInMethod[] | undefined,
): boolean {
  return identityProvider === 'apple' || (methods ?? []).some((m) => m.idp === 'apple');
}

export interface AppleRevokeDeps {
  readonly platform: string;
  readonly workspace: Pick<WorkspaceClient, 'request'>;
  /** iOS: expo-apple-authentication signInAsync → the one-time authorization code. */
  readonly appleAuthorizationCode: () => Promise<string | null>;
  /** Android: opens Apple's authorize URL (expo-web-browser). */
  readonly openBrowser: (url: string) => Promise<unknown>;
}

/** Runs the platform's revocation round trip. Never throws; true when it was attempted. */
export async function revokeAppleBestEffort(deps: AppleRevokeDeps): Promise<boolean> {
  try {
    if (deps.platform === 'ios') {
      const code = await deps.appleAuthorizationCode();
      if (!code) return false;
      const body: AppleRevokeRequest = { authorization_code: code, client: 'ios' };
      await deps.workspace.request<unknown>({
        method: 'POST',
        path: '/v1/sign/me/apple/revoke',
        body,
      });
      return true;
    }
    const r = await deps.workspace.request<{ url?: unknown }>({
      method: 'GET',
      path: '/v1/sign/me/apple/revoke/start',
      query: { return: APPLE_REVOKE_RETURN, format: 'json' },
    });
    const url = r.data?.url;
    if (typeof url !== 'string' || !url.startsWith('https://appleid.apple.com/')) return false;
    await deps.openBrowser(url);
    return true;
  } catch {
    return false;
  }
}
