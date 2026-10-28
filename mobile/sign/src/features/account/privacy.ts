// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — Account → "Delete account / Request
// deletion", for EVERY account type. The app uses the same platform request as the
// web (GET/POST /v1/sign/me/privacy-requests); the session validates identity.
//   Personal: a clear deletion request (closing alone is not deletion).
//   Business: the organization decides about its documents; Aramo removes the
//             member's own Sign data and access and stays responsible.
// The server decides everything; the app shows the request ID, status and what is kept.
import type { components } from '../../api/generated/sign';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { PRODUCTION_API_BASE_URL } from '../../config/env';

export type PrivacyRequest = components['schemas']['SignPrivacyRequest'];

/** The public web flow (no app, no sign-in) — the same capability. */
export const DELETE_ACCOUNT_URL = `${PRODUCTION_API_BASE_URL}/delete-account`;
export const DELETE_CONFIRM_WORD = 'DELETE';

export function deleteConfirmed(typed: string): boolean {
  return typed.trim() === DELETE_CONFIRM_WORD;
}

export async function loadPrivacyRequests(workspace: WorkspaceClient): Promise<PrivacyRequest[]> {
  const r = await workspace.call('/v1/sign/me/privacy-requests', 'get', {});
  return r.items;
}

export async function requestDeletion(workspace: WorkspaceClient): Promise<PrivacyRequest> {
  return workspace.call('/v1/sign/me/privacy-requests', 'post', {
    body: { request_type: 'DELETION', confirm: 'DELETE' },
  });
}

/** The open (not yet closed) deletion request, if any. */
export function openDeletion(items: readonly PrivacyRequest[]): PrivacyRequest | null {
  return items.find((r) => r.request_type === 'DELETION' && r.completed_at === null) ?? null;
}

/**
 * After a deletion request the app signs out (which also wipes local documents,
 * M-A7 §4 R-7) when the session has ended: a Personal account is closed by the
 * request, and a completed request has revoked every Sign session.
 */
export function signOutAfter(request: PrivacyRequest, personal: boolean): boolean {
  return personal || request.status === 'COMPLETED';
}

export function deletionCopy(personal: boolean): { title: string; button: string; points: readonly string[] } {
  return personal
    ? {
        title: 'Delete your account?',
        button: 'Delete account',
        points: [
          'Your account closes now: sending stops and you can’t open or download your documents afterwards, so download what you want to keep first.',
          'We delete your saved signatures and initials, contacts, notifications, device registrations and unsent drafts with their files.',
          'You are signed out everywhere and your sign-in ends once the Aramo privacy team completes it (within 30 days).',
          'We keep only what we must: signed agreements and their evidence, legal acceptances, security logs and abuse reports.',
        ],
      }
    : {
        title: 'Request deletion?',
        button: 'Request deletion',
        points: [
          'Your organization decides about documents it sent or that you received in your role. We refer your request to it.',
          'Aramo removes your own Aramo Sign data (saved signatures, contacts, notifications), signs you out of Aramo Sign and removes your Aramo Sign access.',
          'Aramo stays responsible for your request if your organization doesn’t act.',
        ],
      };
}
