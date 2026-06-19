import { useEffect, useState } from 'react';

import { IconBuilding, IconSliders } from '../../ui/icons';
import { Card } from '../../ui';
import { CompensationDisplayPicker } from '../CompensationDisplayPicker';
import { FinancialsToggle } from '../FinancialsToggle';
import {
  SettingCardHead,
  SettingHint,
  SettingsSeam,
  SettingsSection,
} from '../components';
import { fetchTenantSettings } from '../settings-api';
import type { TenantSettingsView } from '../types';

// Settings Rebuild Directive 1 — Tenant profile.
//
// The Organization + Brand surfaces have only a thin `name`-only Tenant model
// today (no profile/logo endpoint) — HONEST SEAMS, built fully in PR 3. The
// Defaults card is LIVE: the two operator-facing registry settings
// (compensation.display_default, audit.financials_enabled) wired to GET/PUT
// /v1/tenant/settings. The internal metrics.goals key is filtered server-side
// and never reaches this UI.

type State =
  | { status: 'loading' }
  | { status: 'ready'; view: TenantSettingsView }
  | { status: 'error'; message: string };

interface Props {
  readonly fetchFn?: () => Promise<TenantSettingsView>;
}

export function TenantProfileSection({ fetchFn }: Props = {}) {
  const fetcher = fetchFn ?? fetchTenantSettings;
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((view) => {
        if (!cancelled) setState({ status: 'ready', view });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load defaults.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  return (
    <SettingsSection
      title="Tenant profile"
      description="Your workspace identity and the defaults applied across the ATS. Organization details and branding get a full backend in an upcoming release; the workspace defaults below are live today."
    >
      {/* SEAM — Organization (Tenant model is name-only today) */}
      <SettingsSeam
        icon={<IconBuilding />}
        title="Organization & branding"
        vision={[
          'Legal name, registered address, company identifiers and primary domain.',
          'Workspace logo and accent — applied across the app shell.',
          'Primary contacts for billing and security notifications.',
        ]}
      >
        A full tenant-profile model (legal name, address, identifiers, logo, contacts) with its own
        GET/PATCH endpoint and audit trail is on the roadmap. Today the tenant carries only its name,
        so these fields are shown as a roadmap surface rather than editable controls that persist
        nothing.
      </SettingsSeam>

      {/* LIVE — Defaults (the 2 registry settings) */}
      <Card flush>
        <SettingCardHead
          icon={<IconSliders />}
          title="Defaults"
          sub="Tenant-wide configuration backed by the settings registry."
        />
        <div className="rc-card--pad">
          {state.status === 'loading' && (
            <p className="set-muted">Loading defaults…</p>
          )}
          {state.status === 'error' && (
            <p className="set-muted" role="alert">
              {state.message}
            </p>
          )}
          {state.status === 'ready' && (
            <>
              <CompensationDisplayPicker
                initialValue={state.view['compensation.display_default']}
              />
              <FinancialsToggle
                initialValue={state.view['audit.financials_enabled']}
              />
            </>
          )}
          <SettingHint>
            These persist to the tenant settings registry (KNOWN_SETTINGS). Compensation display is
            presentation-only; the financials-grant gate governs the financial-auditor role.
          </SettingHint>
        </div>
      </Card>
    </SettingsSection>
  );
}
