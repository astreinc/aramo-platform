import { useEffect, useState } from 'react';
import { IconSliders } from '@aramo/fe-foundation';

import { Card } from '../../ui';
import { CompensationDisplayPicker } from '../CompensationDisplayPicker';
import { FinancialsToggle } from '../FinancialsToggle';
import { SettingCardHead, SettingHint, SettingsSection } from '../components';
import { fetchTenantSettings } from '../settings-api';
import { TenantProfileForm } from '../profile/TenantProfileForm';
import type { TenantSettingsView } from '../types';

// Settings Rebuild Directive 1 + 3 — Tenant profile.
//
// Directive 3 replaced the D1 Organization & branding seam with the real,
// GET/PATCH-wired <TenantProfileForm> (its own backend + audit trail). The
// Defaults card stays LIVE: the two operator-facing registry settings
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
      description="Your workspace identity, organization details and the defaults applied across the ATS — all live."
    >
      {/* LIVE — Organization & branding (Directive 3) */}
      <TenantProfileForm />

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
