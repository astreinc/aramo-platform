// Reads the `sub` claim of OUR OWN access token to scope on-device data to the signed-in
// user. Not a verification: the server verifies every token; the app never authorizes.
import { base64Decode, utf8Decode } from './bytes';

export function jwtSubject(token: string): string | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(utf8Decode(base64Decode(part))) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}
