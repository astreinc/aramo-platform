// Legal re-acceptance and Personal account close (directive §7 C-5, §11; acceptance
// §12.13). The server lists exactly what is pending and refuses a non-current version;
// the app only shows and echoes it.
//   GET  /v1/sign/legal/status   → { pending: [{ key, version, url, title }] }
//   POST /v1/sign/legal/accept   { accept: [{ key, version }] }
//   GET  /v1/sign/account/status → { closable, closed, closed_at }
//   POST /v1/sign/account/close  { confirm: 'CLOSE', reason? }
import type { components } from '../../api/generated/sign';
import type { WorkspaceClient } from '../../api/workspaceClient';

export type LegalStatus = components['schemas']['SignLegalStatus'];
export type PendingLegal = LegalStatus['pending'][number];
export type AccountStatus = components['schemas']['SignAccountStatus'];

export async function loadLegalStatus(workspace: WorkspaceClient): Promise<LegalStatus> {
  return workspace.call('/v1/sign/legal/status', 'get', {});
}

export async function acceptPending(
  workspace: WorkspaceClient,
  pending: readonly PendingLegal[],
): Promise<LegalStatus> {
  return workspace.call('/v1/sign/legal/accept', 'post', {
    body: { accept: pending.map((p) => ({ key: p.key, version: p.version })) },
  });
}

export async function loadAccountStatus(workspace: WorkspaceClient): Promise<AccountStatus> {
  return workspace.call('/v1/sign/account/status', 'get', {});
}

export const CLOSE_CONFIRM_WORD = 'CLOSE';

/** The close button is enabled only once the user typed CLOSE exactly. */
export function closeConfirmed(typed: string): boolean {
  return typed.trim() === CLOSE_CONFIRM_WORD;
}

export async function closeAccount(workspace: WorkspaceClient, reason?: string): Promise<void> {
  await workspace.call('/v1/sign/account/close', 'post', {
    body: reason?.trim()
      ? { confirm: 'CLOSE', reason: reason.trim().slice(0, 500) }
      : { confirm: 'CLOSE' },
  });
}
