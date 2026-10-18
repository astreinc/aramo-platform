import {
  IconBrowser,
  IconForm,
  IconPlug,
  IconSliders,
} from '@aramo/fe-foundation';

import { SettingsSeam, SettingsSection } from '../components';
import { EmailTemplatesPanel } from '../EmailTemplatesPanel';
import { RequisitionIngestionView } from '../../requisition-imports/RequisitionIngestionView';
import { IntegrationConnectionsPanel } from '../../integrations/IntegrationConnectionsPanel';
import { CommunicationsProvidersPanel } from '../../communications/CommunicationsProvidersPanel';
import { LlmProvidersPanel } from '../../integrations/LlmProvidersPanel';
import { ESignatureProvidersPanel } from '../../integrations/ESignatureProvidersPanel';

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

// D-ORG-3 — Localization, Security & SSO and Plan & billing (organization-owned
// seams) and the live Roles & permissions / Audit log sections moved to
// Organization Administration (libs/org-admin-web, /org/* on the App Home).

// D-EMAIL-TPL-1 (ET-6) — Email & notifications is now a LIVE template-management
// surface (system default + tenant override, RBAC-gated, server-authoritative
// render/validate). It is no longer a seam. Notification preferences remain
// deferred (D-9); provider/mailbox setup stays under Integrations → Communications.
export function EmailSection() {
  return <EmailTemplatesPanel />;
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

// Settings Rebuild D2 — the Audit log seam was REPLACED by the real section
// (settings/audit/AuditSection.tsx). It is no longer a seam.

export function IntegrationsSection() {
  return (
    <SettingsSection
      title="Integrations"
      description="Monitor the requisitions ingested from external systems, and connect Aramo to the job boards and tools your team uses."
    >
      {/* T8-P3 — LIVE, read-only monitoring of provider-neutral requisition
          ingestion. Gated on requisition:import:read (absent scope => absent +
          no fetch). Only this requisition-ingestion portion of the Integrations
          seam is wired; everything below remains an honest seam. */}
      <RequisitionIngestionView />

      {/* T8-CONNECTOR-A — connector connection management. INDEPENDENTLY gated
          on integration:read/write (self-gates; absent scope => absent + no
          fetch). A separate sibling from the P3 monitoring view above, which
          remains governed by requisition:import:read (not regated). */}
      <IntegrationConnectionsPanel />

      {/* COMM-C1 — tenant communication provider configuration (Zoom-only in
          PR-1). INDEPENDENTLY gated on integration:read/write (self-gates; absent
          scope => absent + no fetch). Reads as Settings → Integrations →
          Communications; changes NO recruiting behaviour. */}
      <CommunicationsProvidersPanel />

      {/* TENANT-LLM-1/2 — Settings → Integrations → AI/LLM. Multi-provider BYO:
          select an active provider + supply that provider's OWN key. Self-gates on
          integration:read/write (absent scope => absent + no fetch). Write-only:
          keys are never displayed; unwired providers render as "coming soon". */}
      <LlmProvidersPanel />

      {/* Multi-Provider E-Sign §E/§H — Settings → Integrations → E-Signature. Self-gates
          on integration:read/write (absent scope => absent + no fetch). One active
          provider; the Aramo Sign allowance comes from the backend. */}
      <ESignatureProvidersPanel />

      <SettingsSeam
        icon={<IconPlug />}
        title="Connected apps & API"
        vision={[
          'Job boards — post and sync applicants.',
          'Calendar & comms — Google Workspace, Microsoft 365, Slack.',
          'Developer — API keys and webhooks on the Aramo API.',
        ]}
      >
        Job-board sync, calendar/comms, and the API-key / webhook surface are a future-milestone
        subsystem, surfaced here so the Connect area is complete; nothing here is wired.
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
