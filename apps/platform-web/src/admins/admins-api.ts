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

// CCP-INV-UI-1 (R-1): an attested platform_owner may invite a NEW member straight into one
// commercial role; `role_keys` + `human_ref_hash` (D9) are sent only then, so a plain invite's
// body is unchanged.
export interface PlatformAdminInviteBody {
  email: string;
  display_name?: string;
  role_keys?: string[];
  human_ref_hash?: string;
}

export const adminsApi = {
  invitePlatformAdmin(body: PlatformAdminInviteBody): Promise<PlatformAdminInviteResult> {
    return apiClient.post('/platform/admins/invitations', body);
  },
};

/** The server's D9 rule (`@Matches(/^[0-9a-f]{64}$/)`): lowercase SHA-256 hex. */
export const HUMAN_REF_HASH = /^[0-9a-f]{64}$/;

export function isHumanRefHash(v: string): boolean {
  return HUMAN_REF_HASH.test(v);
}

export const HUMAN_REF_HINT =
  'The person runs: printf \'%s\' \'<their private reference>\' | shasum -a 256 — and gives you only the 64-character result.';

/** CCP-INV-UI-1 R-6: the commercial-role invite refusals (details.reason) → operator copy. */
const COMMERCIAL_INVITE_REFUSAL: Readonly<Record<string, string>> = {
  attester_not_platform_owner: 'Only an attested Platform owner can invite a commercial role.',
  human_ref_required: 'A commercial role needs the person’s identity reference hash.',
  human_ref_in_use: 'This identity reference already belongs to another account. One person, one account.',
  human_ref_not_applicable: 'An identity reference applies only to a commercial role.',
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
  if (typeof reason === 'string' && COMMERCIAL_INVITE_REFUSAL[reason] !== undefined) return COMMERCIAL_INVITE_REFUSAL[reason];
  if (e.code === 'INVITATION_ALREADY_EXISTS' && reason === 'existing_platform_admin') {
    // R-8: an existing member gets a commercial role only by a governed role-change request.
    return 'This person is already a platform admin. To give them a commercial role, use “Request role change…” in Commercial roles.';
  }
  if (e.code === 'INVITATION_ALREADY_EXISTS') return 'This person is already a platform admin.';
  if (e.code === 'EMAIL_UNAVAILABLE') {
    return 'This email already belongs to another organization. One person can belong to only one organization, so use a different email.';
  }
  if (e.code === 'COGNITO_PROVISION_FAILED') {
    return 'We couldn’t create the sign-in account. Nothing was saved. Try again in a minute; if it keeps failing, contact platform engineering.';
  }
  return typeof reason === 'string' && reason.length > 0 ? `${e.message} (${reason})` : e.message;
}
