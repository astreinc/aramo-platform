// User-facing copy for refusals, keyed by `reason` (directive §7 dispositions win over
// the handoff). Feature screens may render richer UI for a reason (e.g. the reminder
// cooldown time); this is the shared fallback text. Never includes server prose.
import type { ApiError } from './errors';

const LINK_ENDED =
  'This link was replaced or has expired. Open the newest email, or sign in to your inbox.';

// The app never creates accounts (M-A1); a federated login with no Aramo user is sent to the web.
const NO_ACCOUNT =
  'There’s no Aramo account for this sign-in. Create one at sign.aramo.ai, or try the other sign-in option.';
const NO_SIGN_ACCESS =
  'Your account doesn’t have access to Aramo Sign. Ask your Aramo administrator to add you.';

const COPY: Record<string, string> = {
  // C-9 — a Personal tenant is Google-only (AUTH-SIGNIN-1 R1).
  idp_not_permitted_for_tenant: 'Personal accounts sign in with Google.',
  invalid_grant: 'Sign-in didn’t finish. Try again.',
  state_mismatch: 'Sign-in didn’t finish. Try again.',
  authorization_denied: 'Sign-in was cancelled.',
  auth_not_configured: 'Sign-in isn’t available in this build.',
  session_expired: 'Your session ended. Sign in again.',
  session_reuse_detected: 'For your security you were signed out. Sign in again.',
  network_unavailable: 'You’re offline. Check your connection and try again.',
  // Principal-resolution denials from /auth/native/sign/token (principalDenialError).
  user_not_provisioned: NO_ACCOUNT,
  no_active_tenant: NO_SIGN_ACCESS,
  membership_inactive: NO_SIGN_ACCESS,
  sign_access_removed: NO_SIGN_ACCESS,
  consumer_not_entitled:
    'Your Aramo plan doesn’t include Aramo Sign. Ask your Aramo administrator.',
  user_inactive: 'This Aramo account is no longer active. For help, contact support@aramo.ai.',
  tenant_closed: 'This Aramo account has been closed. For help, contact support@aramo.ai.',
  tenant_suspended: 'This Aramo account is suspended. For help, contact support@aramo.ai.',
  tenant_resolution_ambiguous:
    'We couldn’t tell which Aramo account to open. For help, contact support@aramo.ai.',
  code_exchange_rejected: 'Sign-in didn’t finish. Try again.',
  // C-21 / M-A2 §2.3 — the app never retries with a stale token.
  SIGNING_SESSION_INVALID: LINK_ENDED,
  SIGNING_SESSION_EXPIRED: LINK_ENDED,
  session_revoked: LINK_ENDED,
  link_expired: LINK_ENDED,
  signing_session_ended: LINK_ENDED,
  // M-A3 §6 — a 412 refreshes the envelope and shows its current state.
  revision_mismatch: 'This envelope changed. Showing the latest version.',
  precondition_required: 'This envelope changed. Showing the latest version.',
  idempotency_request_in_progress: 'Still working on it. Try again in a moment.',
  association_inactive: 'You can no longer sign this from your inbox. Open the newest email link.',
  envelope_not_signable: 'This envelope can’t be signed any more.',
  signer_ineligible: 'You can no longer sign this envelope.',
  // M-A2 §2.2 — SEQUENTIAL routing: an earlier signer has not signed yet.
  not_your_turn: 'It’s not your turn to sign yet. You’ll get an email when it is.',
  ENVELOPE_ALREADY_EXECUTED: 'This envelope can’t be signed any more.',
  recipient_mismatch: 'This link was sent to a different email address.',
  SIGNATURE_FIELD_INCOMPLETE: 'Complete the required fields first',
  phone_verification_required: 'Verify your phone number to send.',
  personal_review_pending: 'Sending is paused while we review your account.',
  legal_acceptance_required: 'Accept the updated terms to keep sending.',
};

export function refusalMessage(error: Pick<ApiError, 'reason' | 'code'>): string {
  return COPY[error.reason] ?? COPY[error.code] ?? 'Something went wrong. Try again.';
}
