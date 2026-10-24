import { ApiError, apiClient } from '@aramo/fe-foundation';

// PLATFORM-UX-1 F-8 (directive R-8, B-1c) — the platform admin invite
// (POST /platform/admins/invitations, platform:admin:invite). The invitee joins
// the Aramo Platform tenant as super_admin. The server refuses an email outside
// PLATFORM_ADMIN_EMAIL_DOMAINS (default aramo.ai) with 400 VALIDATION_ERROR,
// details.reason 'platform_admin_domain_not_allowed'; the client mirrors the
// rule for the default domain.

export interface PlatformAdminInviteResult {
  tenant_id: string;
  user_id: string;
  membership_id: string;
  role_keys: string[];
  status: 'invitation_sent' | 'roles_updated';
}

export const adminsApi = {
  invitePlatformAdmin(body: { email: string; display_name?: string }): Promise<PlatformAdminInviteResult> {
    return apiClient.post('/platform/admins/invitations', body);
  },
};

/** The staff email rule mirrored client-side (the server enforces it too). */
export const STAFF_EMAIL = /^[^@\s]+@aramo\.ai$/i;

export const STAFF_EMAIL_HINT = 'Platform admins must use an @aramo.ai staff email.';

export function isStaffEmail(email: string): boolean {
  return STAFF_EMAIL.test(email.trim());
}

/** An invite refusal → the operator copy. */
export function adminInviteErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'The invitation couldn’t be sent. Try again.';
  const reason = e.details?.['reason'];
  if (reason === 'platform_admin_domain_not_allowed') return STAFF_EMAIL_HINT;
  if (e.code === 'INVITATION_ALREADY_EXISTS') return 'This person is already a platform admin.';
  if (e.code === 'EMAIL_UNAVAILABLE') {
    return 'This email already belongs to another organization. One person can belong to only one organization, so use a different email.';
  }
  if (e.code === 'COGNITO_PROVISION_FAILED') {
    return 'We couldn’t create the sign-in account. Nothing was saved. Try again in a minute; if it keeps failing, contact platform engineering.';
  }
  return typeof reason === 'string' && reason.length > 0 ? `${e.message} (${reason})` : e.message;
}
