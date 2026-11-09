// iOS: the native Apple sheet, used ONLY to obtain a one-time authorization code for token
// revocation at account deletion (Apple Go-Live R-8). Sign-in never uses it (R-1).
import * as AppleAuthentication from 'expo-apple-authentication';

export async function appleAuthorizationCode(): Promise<string | null> {
  if (!(await AppleAuthentication.isAvailableAsync())) return null;
  const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
  return credential.authorizationCode ?? null;
}
