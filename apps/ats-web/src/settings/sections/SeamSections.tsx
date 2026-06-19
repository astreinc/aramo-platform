import {
  IconBrowser,
  IconCard,
  IconForm,
  IconGlobe,
  IconHistory,
  IconLock,
  IconMail,
  IconPlug,
  IconShieldCheck,
  IconSliders,
} from '../../ui/icons';
import { SettingsSeam, SettingsSection } from '../components';

// Settings Rebuild Directive 1 — the honest seams.
//
// Each section renders in the enterprise design but is a clearly-marked
// placeholder — never a working-looking control over nothing (the no-dead-knobs
// invariant). Three classes:
//   • build-later-this-milestone (Roles, Audit): get real PRs next.
//   • future-milestone (Localization, Email, Custom fields, Billing): no
//     substrate yet.
//   • §5-delivered (Security & SSO): wires when Auth-Hardening lands.
//   • REFUSAL-LAYER FORBIDDEN (Career portal, Apply flow): no substrate AND
//     forbidden by the refusal layer — seams by mandate, never wired/stubbed.

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

export function RolesSection() {
  return (
    <SettingsSection
      title="Roles & permissions"
      description="Every role is a named bundle of scopes. The full scope-matrix surface is being built next."
    >
      <SettingsSeam
        icon={<IconShieldCheck />}
        title="Role & scope matrix"
        tag="Next release"
        vision={[
          'The full role catalog with each role’s scopes, surfaced as a real read API.',
          'The scope-per-role matrix — what each of the tenant roles can do, per entity.',
          'Closes the FE hand-mirror: the catalog comes from the backend, not a mirrored list.',
        ]}
      >
        The 13-role catalog, the 60+ scopes and the role→scope map are all built and enforced on the
        server today, but they live in the seed with no read API. The matrix surface (and the
        roles-catalog GET) is the next enterprise PR — seamed here so the surface is complete.
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

export function EmailSection() {
  return (
    <SettingsSection
      title="Email & notifications"
      description="How Aramo sends workflow email on your behalf, the templates recruiters use, and what your team is notified about."
    >
      <SettingsSeam
        icon={<IconMail />}
        title="Sending domain, templates & notifications"
        vision={[
          'Verified sending domain (SPF/DKIM/DMARC) and a default sender.',
          'A template store for submittal, interview, update, offer and consent email.',
          'Team notification preferences (email / in-app).',
        ]}
      >
        There is no email engine yet — only Cognito’s built-in invite email and a no-op delivery
        stub. No template store, sending-domain config or notification-prefs model exists, so nothing
        here would send anything. Built when the email engine ships.
      </SettingsSeam>
    </SettingsSection>
  );
}

export function FieldsSection() {
  return (
    <SettingsSection
      title="Custom fields"
      description="Fields beyond the standard model — captured on records and usable in search and reports."
    >
      <SettingsSeam
        icon={<IconSliders />}
        title="Custom field registry"
        vision={[
          'Add typed custom fields per entity (talent, requisition, company, contact).',
          'Closed-vocabulary validation (String + @IsIn), not free enums.',
          'Surfaced in search and reports.',
        ]}
      >
        Every entity is fixed-schema today — there is no EAV / field-registry / dynamic-attribute
        substrate. This is a cross-system build flagged as a future halt-condition in the settings
        schema; seamed here until it ships.
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

export function AuditSection() {
  return (
    <SettingsSection
      title="Audit log"
      description="Every administrative and security event — a real read surface is being built next."
    >
      <SettingsSeam
        icon={<IconHistory />}
        title="Administrative & security trail"
        tag="Next release"
        vision={[
          'A paginated, filterable read of the existing event trail (actor / event type / date / entity).',
          'Surfaces role changes, setting updates, invites/disables, team/edge/assignment events, sessions.',
          'Scope-gated on a dedicated audit:read scope.',
        ]}
      >
        A real write trail already exists — events emit across identity, settings and the team model
        — but there is no queryable read endpoint yet. The audit-log read surface is the first
        follow-on enterprise PR; seamed here so the surface is complete.
      </SettingsSeam>
    </SettingsSection>
  );
}

export function IntegrationsSection() {
  return (
    <SettingsSection
      title="Integrations"
      description="Connect Aramo to job boards, the VMS platforms that feed requisitions, and the tools your team already uses."
    >
      <SettingsSeam
        icon={<IconPlug />}
        title="Connected apps & API"
        vision={[
          'Job boards — post and sync applicants.',
          'VMS & intake — receive requisitions and submit talent (SAP Fieldglass, Beeline, VNDLY).',
          'Calendar & comms — Google Workspace, Microsoft 365, Slack.',
          'Developer — API keys and webhooks on the Aramo API.',
        ]}
      >
        There is no integrations/connector substrate yet — no job-board sync, VMS intake, or
        API-key / webhook surface. This is a future-milestone subsystem, surfaced here so the
        Connect area is complete; nothing is wired.
      </SettingsSeam>
    </SettingsSection>
  );
}

// ── REFUSAL-LAYER FORBIDDEN — Career portal + Apply flow ──
// No substrate AND forbidden by the refusal layer. These MUST remain seams:
// never wired, stubbed, or implied to function.

export function PortalSection() {
  return (
    <SettingsSection
      title="Career portal"
      description="A talent-facing job site for this tenant — branding, domain and which jobs are public."
    >
      <SettingsSeam
        icon={<IconBrowser />}
        title="Employer job board"
        forbidden
        vision={[
          'Branded careers site, custom domain and SEO.',
          'Control which open requisitions are published.',
        ]}
      >
        Aramo has no employer job-board substrate, and the refusal layer forbids building one here.
        This is shown on the roadmap only — it is not wired, stubbed, or configurable.
      </SettingsSeam>
    </SettingsSection>
  );
}

export function ApplySection() {
  return (
    <SettingsSection
      title="Apply flow"
      description="The talent application — fields, screening questions and consent captured when someone applies."
    >
      <SettingsSeam
        icon={<IconForm />}
        title="Talent application builder"
        forbidden
        vision={[
          'Configurable application fields and a form builder.',
          'Screening questions and knockout logic.',
          'Consent-at-apply capture.',
        ]}
      >
        There is no talent-apply substrate (submittals are recruiter-initiated, not talent
        applications), and the refusal layer forbids building one here. Shown on the roadmap only —
        not wired, stubbed, or configurable.
      </SettingsSeam>
    </SettingsSection>
  );
}
