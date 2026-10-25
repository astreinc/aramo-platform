// Devices / native sessions (directive §9 "Device revocation"; M-A1 §3.6):
//   GET    /auth/native/sign/sessions                       — the caller's live sessions
//   DELETE /auth/native/sign/sessions/{device_session_id}   — owner only (else 404)
// Revoking kills that device's refresh-token family and its push registration
// server-side. Revoking THIS device ends the session here too: the app signs out.
import type { components } from '../../api/generated/auth';
import { fillPath } from '../../api/types';
import type { WorkspaceClient } from '../../api/workspaceClient';

export type NativeSession = components['schemas']['NativeSessionList']['items'][number];

export const SESSIONS_PATH = '/auth/native/sign/sessions' as const;

export async function listSessions(workspace: WorkspaceClient): Promise<NativeSession[]> {
  const r = await workspace.request<components['schemas']['NativeSessionList']>({
    method: 'GET',
    path: SESSIONS_PATH,
  });
  const items = [...(r.data?.items ?? [])];
  // This device first, then most recently seen.
  return items.sort((a, b) =>
    a.current !== b.current
      ? a.current
        ? -1
        : 1
      : String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')),
  );
}

export type RevokeOutcome = 'revoked' | 'revoked_current' | 'not_found';

/**
 * Revoke one session. `signOut` runs when the revoked session is this device (the
 * server has already ended it; sign-out clears the device).
 */
export async function revokeSession(
  workspace: WorkspaceClient,
  session: Pick<NativeSession, 'device_session_id' | 'current'>,
  signOut: () => Promise<void>,
): Promise<RevokeOutcome> {
  try {
    await workspace.request({
      method: 'DELETE',
      path: fillPath('/auth/native/sign/sessions/{device_session_id}', {
        device_session_id: session.device_session_id,
      }),
    });
  } catch (e) {
    if ((e as { status?: number }).status === 404) return 'not_found';
    throw e;
  }
  if (session.current) {
    await signOut().catch(() => undefined);
    return 'revoked_current';
  }
  return 'revoked';
}

export function deviceLabel(
  s: Pick<NativeSession, 'platform' | 'app_version' | 'current'>,
): string {
  const os =
    s.platform === 'ios' ? 'iPhone' : s.platform === 'android' ? 'Android phone' : 'Device';
  return `${os}${s.current ? ' (this device)' : ''}`;
}
