// Client Rule Consolidation C3 (audit rows 8, 17, 29; directive §5) — server refusal → user
// copy, ONE map for both Sign clients. Keyed by the refusal's `details.reason`, then its
// error `code`. The server's own message text is NEVER shown (it can name ids and internal
// state); an unmapped refusal gets a plain fallback. Where the two former maps disagreed the
// mobile wording was kept, with any screen it named made neutral ("your plan settings").
import { pdfProblemText } from '@aramo/sign-fields';

import { CLOUD_FEATURE_COPY, CLOUD_STORAGE_REFUSAL_COPY } from './cloud-storage.js';
import { WORD_COPY } from './file-rules.js';
import { FOLDER_COPY } from './folders.js';
import { isDailyAllowance, limitReachedCopy } from './plan.js';
import { ACCESS_CODE_MAX_LENGTH, ACCESS_CODE_MIN_LENGTH, PHONE_HINT, SIGNERS_FULL_MESSAGE } from './validation.js';
import { MAX_COPY_RECIPIENTS } from './recipients.js';
import { PHONE_STEP_UP_REFUSAL_COPY } from './phone-step-up.js';
import { SIGNER_FIELD_VALUE_COPY } from './signer-field-input.js';

export const FALLBACK_MESSAGE = 'Something went wrong. Try again.';
export const ENVELOPE_CHANGED = 'This envelope changed. Showing the latest version.';
export const ENVELOPE_NOT_AVAILABLE = 'This envelope isn’t available. It may have been deleted, or you don’t have access to it.';
export const INBOX_ITEM_CHANGED = 'This item changed. Showing your latest inbox.';
export const SELF_SIGN_NO_REMINDERS = 'A document you sign yourself has no one to remind.';
export const NO_PERMISSION = 'You don’t have permission to do that.';
export const STORAGE_FULL = 'Your storage is full. Remove draft documents you no longer need, or see your plan settings for more storage.';

const LINK_ENDED = 'This link was replaced or has expired. Open the newest email, or sign in to your inbox.';
const NO_ACCOUNT = 'There’s no Aramo account for this sign-in yet.';
const NO_SIGN_ACCESS = 'Your account doesn’t have access to Aramo Sign. Ask your Aramo administrator to add you.';

/** The recipient (Send flow) refusals and client checks (sign-service reasons). */
export const RECIPIENT_COPY = {
  duplicate: 'This person is already on the envelope.',
  signers_full: SIGNERS_FULL_MESSAGE,
  too_many_signers: SIGNERS_FULL_MESSAGE,
  copies_full: `An envelope can have at most ${MAX_COPY_RECIPIENTS} people who receive a copy.`,
  too_many_copy_recipients: `An envelope can have at most ${MAX_COPY_RECIPIENTS} people who receive a copy.`,
  email_required: 'Add an email address for this person, or choose Signs in person.',
  copy_delivery_required: 'Choose when each copy recipient receives their copy.',
  copy_recipient_has_fields: 'People who receive a copy can’t have fields.',
  assign_to_me_not_signer: 'Only a signer can be assigned to you.',
  assign_to_me_email_mismatch: 'You can assign a recipient to yourself only with your own verified account email.',
  witness_for_required: 'Choose the signer each witness signs for.',
  witness_for_invalid: 'A witness signs for a signer.',
  witness_duplicate: 'A signer can have only one witness.',
  witness_for_not_allowed: 'Only a witness signs for someone else.',
  plan_not_eligible: 'This option is available on Business plans.',
  access_code_invalid: `Access codes are ${ACCESS_CODE_MIN_LENGTH} to ${ACCESS_CODE_MAX_LENGTH} letters, numbers or symbols.`,
  access_code_not_allowed: 'Only people who sign from a link can have an access code.',
  identity_verification_not_link_signer: 'Only people who sign from a link can have an identity check.',
  invalid_phone: PHONE_HINT,
  recipient_kind_not_supported: 'Text messages and SMS codes are for signers only.',
  messaging_provider_not_configured: 'Text messages can’t reach this number right now.',
} as const;

/** Keyed by details.reason (or, where a code has no reason, by the code). */
export const REFUSAL_COPY: Readonly<Record<string, string>> = {
  ...WORD_COPY,
  ...RECIPIENT_COPY,
  // SIGN-FREE-PARITY-1 S6 — cloud storage import and export.
  ...CLOUD_STORAGE_REFUSAL_COPY,
  // FIELD-PARITY-1 P3 §6 — a field value the server refused (fill: VALIDATION_ERROR details.reason).
  ...SIGNER_FIELD_VALUE_COPY,
  // SIGN-FREE-PARITY-1 S7 — a folder name or the folder cap the server refused.
  folder_name_empty: FOLDER_COPY.folder_name_empty,
  folder_name_too_long: FOLDER_COPY.folder_name_too_long,
  folder_name_taken: FOLDER_COPY.folder_name_taken,
  folder_limit_reached: FOLDER_COPY.folder_limit_reached,
  folder_not_found: FOLDER_COPY.folder_not_found,
  // SIGN-FREE-PARITY-1 S2 — the sender's own phone step-up (v1/sign/personal/step-up).
  ...PHONE_STEP_UP_REFUSAL_COPY,
  // Sign-in (native auth, M-A1; Apple Go-Live A1).
  idp_not_permitted_for_tenant: 'Your account doesn’t use this sign-in option. Sign in the way you usually do.',
  invalid_grant: 'Sign-in didn’t finish. Try again.',
  state_mismatch: 'Sign-in didn’t finish. Try again.',
  authorization_denied: 'Sign-in was cancelled.',
  auth_not_configured: 'Sign-in isn’t available in this build.',
  session_expired: 'Your session ended. Sign in again.',
  session_reuse_detected: 'For your security you were signed out. Sign in again.',
  network_unavailable: 'You’re offline. Check your connection and try again.',
  user_not_provisioned: NO_ACCOUNT,
  no_active_tenant: NO_SIGN_ACCESS,
  membership_inactive: NO_SIGN_ACCESS,
  sign_access_removed: NO_SIGN_ACCESS,
  consumer_not_entitled: 'Your Aramo plan doesn’t include Aramo Sign. Ask your Aramo administrator.',
  user_inactive: 'This Aramo account is no longer active. For help, contact support@aramo.ai.',
  tenant_closed: 'This Aramo account has been closed. For help, contact support@aramo.ai.',
  tenant_suspended: 'This Aramo account is suspended. For help, contact support@aramo.ai.',
  tenant_resolution_ambiguous: 'We couldn’t tell which Aramo account to open. For help, contact support@aramo.ai.',
  code_exchange_rejected: 'Sign-in didn’t finish. Try again.',
  idp_identity_conflict: 'You already have an Aramo account. Confirm it’s you.',
  identity_already_linked: 'This sign-in is already connected to another Aramo account.',
  idp_already_linked: 'Your account already has a sign-in from this provider. Remove it first to connect a different one.',
  last_sign_in_method: 'You can’t remove your only sign-in method. Add another one first.',
  code_invalid: 'That code isn’t right. Check the code and try again.',
  code_expired: 'This code has expired. Send a new code.',
  code_attempts_exceeded: 'Too many wrong codes. Start again to get a new code.',
  // Signing links and sessions (C-21, M-A2 §2.2–§2.3).
  SIGNING_SESSION_INVALID: LINK_ENDED,
  SIGNING_SESSION_EXPIRED: LINK_ENDED,
  session_revoked: LINK_ENDED,
  link_expired: LINK_ENDED,
  signing_session_ended: LINK_ENDED,
  association_inactive: 'You can no longer sign this from your inbox. Open the newest email link.',
  envelope_not_signable: 'This envelope can’t be signed any more.',
  signer_ineligible: 'You can no longer sign this envelope.',
  not_your_turn: 'It’s not your turn to sign yet. You’ll get an email when it is.',
  ENVELOPE_ALREADY_EXECUTED: 'This envelope can’t be signed any more.',
  recipient_mismatch: 'This link was sent to a different email address.',
  SIGNATURE_FIELD_INCOMPLETE: 'Complete the required fields first',
  // Web Self-Signing W1 — self-sign session refusals.
  not_bound_to_you: 'This signer isn’t assigned to you. Use the link in the signing email.',
  email_not_verified: 'Your account email isn’t verified, so you can’t sign here. Use the link in the signing email.',
  // Field-test batch 1 A2 SGN-2 — the remaining session refusals say why, not the generic text.
  signer_not_found: 'That recipient is no longer on this envelope.',
  not_in_person_signer: 'Only an in-person signer can sign on this device.',
  // Concurrency (M-A3 §6, §8; UAT SND-23).
  revision_mismatch: ENVELOPE_CHANGED,
  precondition_required: ENVELOPE_CHANGED,
  idempotency_request_in_progress: 'Still working on it. Try again in a moment.',
  // Envelopes (UAT DOC-04, W2 A3.4, Retention and Purge).
  ENVELOPE_NOT_FOUND: ENVELOPE_NOT_AVAILABLE,
  inbox_item_not_found: INBOX_ITEM_CHANGED,
  ENVELOPE_PURGED: 'This envelope’s documents were purged and can’t be downloaded.',
  ENVELOPE_ILLEGAL_TRANSITION: 'This envelope can’t be changed in its current state.',
  self_sign_no_reminders: SELF_SIGN_NO_REMINDERS,
  // Storage (UAT DOC-06) — one wording for Personal and Business.
  ESIGN_STORAGE_QUOTA_EXCEEDED: STORAGE_FULL,
  // Personal sending gate (Personal Free §6).
  personal_sending_not_enabled: 'Sending from a personal account isn’t enabled yet.',
  phone_verification_required: 'Verify your phone number to send.',
  personal_review_pending: 'Sending is paused while we review your account.',
  legal_acceptance_required: 'Accept the updated terms to keep sending.',
  personal_restricted:
    'Sending is paused on your account while we review it. Envelopes you already sent aren’t affected. Contact Aramo support if you think this is a mistake.',
  personal_location_not_supported: 'Aramo Sign Personal is currently available in the United States and India.',
  // Plan and features (Catalog v2 P-6, Feature-Parity §1.13).
  ESIGN_NOT_SUBSCRIBED: 'Your organization doesn’t have an active Aramo Sign plan, so envelopes can’t be sent. An admin can choose a plan in your plan settings.',
  templates_not_in_plan: 'Templates aren’t included in the Free plan. They come with every paid Aramo Sign plan.',
  ESIGN_FEATURE_NOT_AVAILABLE: 'This isn’t available on your Aramo Sign plan yet.',
  RTR_TEMPLATE_BINDING_MISSING: 'Fill in every template field before creating the envelope.',
  TEMPLATE_SELECTION_REQUIRED: 'Your organization needs to choose a template for this document type. An admin can do this in Org Home.',
  // Billing (Catalog v2 §4.3, per-seat §3.3–§3.5, India §4.11, Signup A1 §2.6, Domain P3 §4).
  ESIGN_BILLING_UNAVAILABLE: 'Online billing isn’t available right now. Try again later, or contact Aramo support.',
  ESIGN_BILLING_CONFLICT: 'Your organization can’t subscribe right now. Check Settings, or contact Aramo.',
  ALREADY_SUBSCRIBED: 'Your organization already has a subscription. Use Manage billing or cancel to change it.',
  governed_subscription_open: 'Your organization’s subscription is managed by Aramo. Contact Aramo to change it.',
  PLAN_NOT_ELIGIBLE: 'Standard Professional is for organizations with an Aramo ATS subscription.',
  organization_country_not_supported: 'Aramo Sign is currently available to organizations registered in the United States.',
  organization_profile_incomplete: 'Add your organization’s legal name, US address and billing email in Settings before subscribing.',
  domain_verification_required: 'Verify your organization’s email domain before subscribing. You can assign this to your IT administrator.',
  NO_BILLING_ACCOUNT: 'Your organization doesn’t have a billing account yet. Choose a plan first.',
  seats_not_applicable: 'Seats can’t be changed for this subscription.',
  seats_unchanged: 'That’s already your number of seats.',
  term_not_available: 'That billing option isn’t available for this plan. Choose another option and try again.',
  TERMS_NOT_ACCEPTED: 'Check “I agree” to accept the terms before you continue.',
  PORTAL_NOT_CONFIGURED: 'Billing management will be available soon; contact support@aramo.ai.',
  personal_paid_checkout_not_enabled: 'Upgrading to Standard isn’t available yet.',
  personal_paid_us_only: 'Standard isn’t available in your country yet.',
  // Account close (Personal Free).
  not_account_owner: 'Only the account owner can close this account.',
  business_account_close_via_organization: 'An organization account is closed by its organization administrator.',
  account_close_confirmation_required: 'Type CLOSE to confirm closing your account.',
  personal_account_not_closable: 'This account can’t be closed here. Contact Aramo support.',
};

/** Copy keyed by details.feature_key for a feature refusal (ESIGN_FEATURE_NOT_AVAILABLE). */
const FEATURE_COPY: Readonly<Record<string, string>> = {
  'sign.reports': 'Reports aren’t available on your Aramo Sign plan yet.',
  ...CLOUD_FEATURE_COPY,
};

export interface RefusalInput {
  readonly code: string;
  /** details.reason; a client may pass the code again when there is none. */
  readonly reason?: string | null;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>> | null;
  /** A 429's retry time (details.retry_at, or computed from Retry-After by the client). */
  readonly retryAt?: string | null;
}

export interface RefusalFormat {
  /** A time ("Oct 22, 9:14 AM") in the user's locale; null for a missing / invalid one. */
  readonly time?: (iso: string) => string | null;
  /** A date in the user's locale; null for a missing / invalid one. */
  readonly date?: (iso: string) => string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** UAT SND-23 — a reminder refused because the envelope changed elsewhere (409, no reason). */
export function isReminderStale(e: RefusalInput): boolean {
  const reason = e.reason ?? null;
  return e.status === 409 && e.code === 'ESIGN_REMINDER_NOT_ALLOWED' && (reason === null || reason === e.code);
}

export const SEAT_LIMIT_REASON = 'seat_limit_reached';
export function seatLimitMessage(purchased: unknown): string {
  return `All ${typeof purchased === 'number' ? `${purchased} ` : ''}seats are in use. Add a seat to invite more people.`;
}

/** Row 8 — the reminder limits (60 minutes per signer; 5 a day per envelope), with the time when known. */
export function reminderLimitMessage(reason: 'reminder_cooldown' | 'reminder_daily_limit', at: string | null): string {
  const head =
    reason === 'reminder_daily_limit' ? 'This envelope has had the most reminders allowed in 24 hours.' : 'This signer was reminded less than an hour ago.';
  return at === null ? head : `${head} You can send another reminder at ${at}.`;
}

/** The user copy for a server refusal. Never the server's own text. */
export function refusalMessage(e: RefusalInput, fmt: RefusalFormat = {}, fallback: string = FALLBACK_MESSAGE): string {
  const details = e.details ?? {};
  const reason = str(e.reason) ?? str(details['reason']);
  const time = (iso: unknown): string | null => (str(iso) === null ? null : (fmt.time?.(iso as string) ?? null));
  const date = (iso: unknown): string | null => (str(iso) === null ? null : (fmt.date?.(iso as string) ?? null));

  if (e.code === 'ESIGN_ALLOWANCE_EXHAUSTED') {
    const limit = num(details['limit']);
    return isDailyAllowance(details)
      ? limitReachedCopy('daily', limit, time(details['next_available_at'])).body
      : limitReachedCopy('monthly', limit, date(details['period_end'])).body;
  }
  if (reason === 'reminder_cooldown' || reason === 'reminder_daily_limit') return reminderLimitMessage(reason, time(e.retryAt ?? details['retry_at']));
  if (isReminderStale(e)) return ENVELOPE_CHANGED;
  if (reason === SEAT_LIMIT_REASON) return seatLimitMessage(details['purchased']);
  if (reason === 'seats_below_usage') {
    const used = num(details['used']);
    return used !== null
      ? `${used} people are using seats, so you need at least ${used} seats. Remove someone’s Aramo Sign access first to go lower.`
      : 'You can’t have fewer seats than the people using them. Remove someone’s Aramo Sign access first to go lower.';
  }
  if (reason === 'unsafe_pdf' || reason === 'pdf_unsafe' || reason === 'pdf_invalid') {
    return pdfProblemText(details['pdf_problem']);
  }
  if (reason !== null && REFUSAL_COPY[reason] !== undefined) return REFUSAL_COPY[reason] as string;
  const feature = str(details['feature_key']);
  if (e.code === 'ESIGN_FEATURE_NOT_AVAILABLE' && feature !== null && FEATURE_COPY[feature] !== undefined) return FEATURE_COPY[feature] as string;
  if (REFUSAL_COPY[e.code] !== undefined) return REFUSAL_COPY[e.code] as string;
  if (e.status === 403) return NO_PERMISSION;
  return fallback;
}

