import { IconCard, IconGlobe, IconLock, SettingsSeam, SettingsSection } from '@aramo/fe-foundation';

// D-ORG-3 — the organization-owned honest seams, relocated from ATS Settings
// (Settings Rebuild Directive 1): clearly-marked placeholders, never a working-
// looking control over nothing (the no-dead-knobs invariant). Localization,
// Security & SSO and Plan & billing are SHARED organization concerns, so they
// live here rather than inside any one product.

export function LocalizationSection() {
  return (
    <SettingsSection
      title="Localization"
      description="Tenant defaults for language, currency, timezone and formats — with per-branch overrides."
    >
      <SettingsSeam
        icon={<IconGlobe />}
        title="Language & regional formats"
        vision={[
          'Tenant default language, currency, timezone, date/number formats and week-start.',
          'Per-branch overrides so a New York desk can differ from a remote pod.',
        ]}
      >
        There is no i18n/locale substrate yet (requisition currency is per-record text, not a tenant
        default). When the localization infrastructure lands, these become enforced preferences.
      </SettingsSeam>
    </SettingsSection>
  );
}

export function SecuritySection() {
  return (
    <SettingsSection
      title="Security & SSO"
      description="Authentication runs on AWS Cognito with federated Google and Microsoft sign-in. Tenant-level SSO/MFA/session policy is delivered by the §5 Auth-Hardening milestone."
    >
      <SettingsSeam
        icon={<IconLock />}
        title="SSO, MFA & session policy"
        tag="Delivered by §5"
        vision={[
          'Enforce SSO for all members; require MFA tenant-wide.',
          'Session timeout and revoke-on-logout policy.',
          'Allowed email domains for invite / self-join.',
        ]}
      >
        Cognito hosted sign-in (with Google/Microsoft federation) is the whole auth story today —
        there is no tenant SSO/SAML, MFA-policy, session-policy or IP-allowlist substrate. This
        section wires when §5 Auth-Hardening delivers it.
      </SettingsSeam>
    </SettingsSection>
  );
}

export function BillingSection() {
  return (
    <SettingsSection
      title="Plan & billing"
      description="Your subscription, seats and usage."
    >
      <SettingsSeam
        icon={<IconCard />}
        title="Subscription & invoices"
        vision={[
          'Current plan, seat usage and AI-credit usage.',
          'Invoice history and payment method.',
          'Plan changes and entitlement gates.',
        ]}
      >
        There is no billing/subscription/payment substrate — entitlement gates are capability flags
        and metering is a write-only usage log, neither is billing. This is a deferred Phase-B track,
        surfaced here so the account area is complete.
      </SettingsSeam>
    </SettingsSection>
  );
}
