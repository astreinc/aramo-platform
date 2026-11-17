// Aramo-Sign-Mobile-Amendment-M-A16-Web-Save-to-Inbox-v1_0 §2 / §4 — the hand-off of a
// signing token from the guest signing page to the signed-in workspace, through this
// browser tab's sessionStorage (it survives the sign-in round trip in the same tab and
// is never put in a URL). Shared by both zones: no session, no API, no workspace code.
// Every access is guarded: blocked storage means no hand-off, never an error.

export const INBOX_CLAIM_HANDOFF_KEY = 'aramo-sign-inbox-claim';

/** Guest side: keep the token for the workspace. False when storage is unavailable. */
export function stashInboxClaim(token: string): boolean {
  try {
    window.sessionStorage.setItem(INBOX_CLAIM_HANDOFF_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** Workspace side: take the token once (it is removed immediately), or null. */
export function takeInboxClaim(): string | null {
  try {
    const t = window.sessionStorage.getItem(INBOX_CLAIM_HANDOFF_KEY);
    window.sessionStorage.removeItem(INBOX_CLAIM_HANDOFF_KEY);
    return t !== null && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
