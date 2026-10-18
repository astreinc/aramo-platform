import { IconGlobe, IconLock, SettingsSeam, SettingsSection } from '@aramo/fe-foundation';

// Organization-owned honest seams (Settings Rebuild Directive 1 discipline): a
// clearly-marked placeholder, never a working-looking control over nothing.

/** Settings tab — shared defaults every Aramo app reads. */
export function OrgSettingsSection() {
  return (
    <SettingsSection
      title="Settings"
      description="Defaults shared by every Aramo app your organization uses. App-specific configuration stays in each app's own Settings."
    >
      <SettingsSeam
        icon={<IconGlobe />}
        title="Language & regional formats"
        vision={[
          'Organization default language, currency, time zone, date and number formats, and week start.',
          'Per-site overrides so one office can differ from another.',
          'People can still choose their own language and time zone in My preferences.',
        ]}
      >
        There is no locale substrate yet (requisition currency is per-record text, not an organization
        default). When it lands, these become enforced defaults for every app.
      </SettingsSeam>
    </SettingsSection>
  );
}

/** Identity provider / SSO policy — part of the Domain page. */
export function SsoSeam() {
  return (
    <SettingsSeam
      icon={<IconLock />}
      title="Single sign-on & sign-in policy"
      tag="Delivered by §5"
      vision={[
        'Enforce single sign-on for every member; require multi-factor sign-in organization-wide.',
        'Session timeout and sign-out policy.',
        'Allowed email domains for invitations.',
      ]}
    >
      Sign-in runs on Aramo's hosted login with federated Microsoft and Google accounts. There is no
      organization-level SSO, MFA or session-policy setting yet; this wires when the §5 Auth-Hardening
      milestone delivers it.
    </SettingsSeam>
  );
}
