import { useState } from 'react';
import { ApiError, useToast } from '@aramo/fe-foundation';

import { IconDownload, IconLock, IconShieldCheck } from '../../ui/icons';
import { Button, Card } from '../../ui';
import type { ExportEntityType } from '../admin-types';
import { EXPORT_ENTITIES } from '../admin-types';
import {
  SettingCardHead,
  SettingHint,
  SettingRow,
  SettingsSeam,
  SettingsSection,
  StatChip,
} from '../components';
import { downloadExport, ExportError } from '../export-api';

// Settings Rebuild Directive 1 — Data & compliance.
//
// Export is LIVE (GET /v1/exports/:entity_type — the 5 R10-bounded ATS entities
// as CSV; scope export:read seeded this PR). Retention and RTBF have no self-
// serve substrate yet, so they are HONEST SEAMS — Retention marked coming-soon,
// RTBF surfacing the real manual-runbook + portal status (never a fake toggle).

export function ComplianceSection() {
  const toast = useToast();
  const [busy, setBusy] = useState<ExportEntityType | null>(null);

  const onExport = async (entity: ExportEntityType, label: string) => {
    setBusy(entity);
    try {
      await downloadExport(entity);
      toast.show(`${label} export started`);
    } catch (err: unknown) {
      const message =
        err instanceof ExportError || err instanceof ApiError
          ? err.message
          : 'Export failed.';
      toast.show(message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      title="Data & compliance"
      description="Export, retention and right-to-be-forgotten policy for the tenant. Aramo is privacy-first by construction — export is live today; the policy engines are on the roadmap."
    >
      {/* LIVE — Export */}
      <Card flush>
        <SettingCardHead
          icon={<IconDownload />}
          title="Data export"
          sub="Download tenant data as CSV. Each export respects record-level visibility and the R10 boundary (ATS fields only)."
        />
        <div className="rc-card--pad">
          <div className="set-expgrid">
            {EXPORT_ENTITIES.map((e) => (
              <div className="set-row" key={e.type} style={{ borderBottom: 0, padding: '8px 0' }}>
                <div className="set-row__l">
                  <div className="set-row__t">{e.label}</div>
                  <div className="set-row__s">{e.description}</div>
                </div>
                <div className="set-row__r">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => onExport(e.type, e.label)}
                    data-testid={`export-${e.type}`}
                  >
                    {busy === e.type ? 'Exporting…' : 'Export CSV'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <SettingHint>
            Exports are bounded to ATS-domain fields — no Core judgment data leaves this surface.
            Large datasets are capped at 10,000 rows per request.
          </SettingHint>
        </div>
      </Card>

      {/* HONEST — RTBF status (manual runbook + portal), no fake toggle */}
      <Card flush>
        <SettingCardHead
          icon={<IconShieldCheck />}
          title="Consent & right-to-be-forgotten"
          sub="The current, honest status — not a configurable toggle."
        />
        <div className="rc-card--pad set-rows">
          <SettingRow
            title="Require consent before contact"
            sub="Contact is blocked unless contacting-consent is on the record. Enforced in the engagement layer."
          >
            <StatChip tone="ok" dot>
              Enforced
            </StatChip>
          </SettingRow>
          <SettingRow
            title="Talent-initiated erasure (RTBF)"
            sub="Talent can request erasure from the talent portal. Résumé text is purged on talent delete; the consent ledger is retained."
          >
            <StatChip tone="info" dot>
              Portal-enabled
            </StatChip>
          </SettingRow>
          <SettingRow
            title="Admin-initiated erasure"
            sub="Performed today via the documented operational runbook (talent-rtbf-erasure). A self-serve admin erasure surface is on the roadmap."
          >
            <StatChip tone="muted">Manual runbook</StatChip>
          </SettingRow>
        </div>
      </Card>

      {/* SEAM — Retention policy (no substrate yet) */}
      <SettingsSeam
        icon={<IconLock />}
        title="Retention policy"
        vision={[
          'Set tenant retention windows for résumé text and inactive talent (e.g. 12 / 24 months, until-deletion).',
          'Auto-flag inactive talent for review after a no-engagement period.',
          'Scheduled purge jobs honouring per-tenant policy — distinct from S3 lifecycle and RDS PITR.',
        ]}
      >
        Tenant-configurable retention and TTL/purge policy has no substrate yet. When it ships,
        these windows become real, enforced jobs — until then nothing here would control anything,
        so it is shown as a roadmap surface, not a live control.
      </SettingsSeam>
    </SettingsSection>
  );
}
