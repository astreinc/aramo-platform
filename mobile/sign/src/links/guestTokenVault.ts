// In-memory hand-off of a signing capability token from the link router to the guest
// signing screen (M-A2 §2.1, §3.4). Navigation params carry an opaque handle, never the
// token, so the token can't appear in navigation state, devtools or persisted state.
// A handle is single-use; nothing is ever written to disk.
import { randomId } from '../util/ids';

const vault = new Map<string, string>();

export function stashGuestToken(token: string, newHandle: () => string = randomId): string {
  const handle = newHandle();
  vault.set(handle, token);
  return handle;
}

/** Returns the token once and forgets it. */
export function takeGuestToken(handle: string): string | null {
  const token = vault.get(handle) ?? null;
  vault.delete(handle);
  return token;
}

export function clearGuestTokens(): void {
  vault.clear();
}
