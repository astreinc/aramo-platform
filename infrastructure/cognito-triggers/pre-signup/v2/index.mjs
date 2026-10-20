// Aramo — Cognito PreSignUp trigger, v2 (governed replacement for the
// deployed `cognito-pre-signup-auto-link`, see ../deployed-2025-12-18/).
//
// Lead Architect HALT disposition 2026-10-20, Option A. Invariants:
//   1. No Cognito-level identity merging: this trigger NEVER calls
//      AdminLinkProviderForUser. A federated sign-in never inherits another
//      user's subject (no subject substitution).
//   2. No manufactured verification: this trigger NEVER sets
//      `autoVerifyEmail`. Verified-email evidence comes only from the
//      provider's own claim, mapped to `email_verified` by the pool's
//      attribute mapping (Google: email_verified; microsoft: xms_edov).
//   3. With REQUIRE_PROVIDER_EMAIL_VERIFIED=true (default) a first federated
//      sign-in whose provider did not assert a verified email is refused here,
//      before any Cognito user is created.
//   4. Binding a pre-provisioned Aramo user happens inside Aramo (its own
//      ExternalIdentity record, provider-checked), never by Cognito linking.
//   5. No-JIT is unaffected: Aramo still refuses any email it has not
//      pre-provisioned (`user_not_provisioned`).
//   6. Existing associations are untouched: this trigger only runs when a NEW
//      federated user is created; it never edits or removes existing links.
// Every decision is logged as one structured line (email domain only, no
// full address) for an auditable record in CloudWatch.

const REQUIRE_VERIFIED = (process.env.REQUIRE_PROVIDER_EMAIL_VERIFIED ?? 'true').trim().toLowerCase() !== 'false';
// Federated providers accepted by this pool (exact Cognito provider names,
// compared case-insensitively). Anything else is refused.
const ALLOWED_PROVIDERS = (process.env.ALLOWED_PROVIDERS ?? 'Google,microsoft')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function providerOf(userName) {
  const i = typeof userName === 'string' ? userName.indexOf('_') : -1;
  return i > 0 ? userName.slice(0, i).toLowerCase() : null;
}

function domainOf(email) {
  const at = typeof email === 'string' ? email.lastIndexOf('@') : -1;
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function audit(decision, fields) {
  console.log(JSON.stringify({ trigger: 'pre-signup-v2', decision, ...fields }));
}

export const handler = async (event) => {
  // Native (admin-created) users and other sources are not this trigger's concern.
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') return event;

  const attrs = event.request?.userAttributes ?? {};
  const provider = providerOf(event.userName);
  const email_domain = domainOf(attrs.email);
  const verified = String(attrs.email_verified ?? '').toLowerCase() === 'true';
  const base = { provider, email_domain, provider_email_verified: verified };

  if (provider === null || !ALLOWED_PROVIDERS.includes(provider)) {
    audit('refused_provider', base);
    throw new Error('Sign-in provider is not permitted.');
  }
  if (!attrs.email) {
    audit('refused_no_email', base);
    throw new Error('Your account did not share an email address.');
  }
  if (REQUIRE_VERIFIED && !verified) {
    audit('refused_unverified_email', base);
    throw new Error('Your sign-in provider has not verified your email address.');
  }

  // Never link, never auto-verify, never substitute a subject.
  audit('allowed', base);
  return event;
};
