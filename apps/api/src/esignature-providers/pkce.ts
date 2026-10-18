import { createHash, randomBytes } from 'node:crypto';

// RFC 7636 PKCE (S256). The verifier stays server-side with the single-use state.
export function newCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
