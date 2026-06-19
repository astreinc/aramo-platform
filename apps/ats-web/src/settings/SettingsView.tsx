import { useEffect, useState } from 'react';

import { InlineAlert, PageHeader } from '../ui';

import { CompensationDisplayPicker } from './CompensationDisplayPicker';
import { FinancialsToggle } from './FinancialsToggle';
import { fetchTenantSettings } from './settings-api';
import type { TenantSettingsView } from './types';

// Settings admin surface — ported to ats-web /admin/settings (FE Consolidation
// Directive 3; restyled to Confident Blue). Backend contract UNCHANGED:
// GET /v1/tenant/settings (tenant:admin:settings) returns only the operator-
// facing keys — the internal metrics.goals key is filtered server-side and is
// not part of TenantSettingsView, so it can never reach this UI.

interface Props {
  // Test seam — lets the test inject a fetch fn so the view renders the
  // settings without going through the real api client.
  fetchFn?: () => Promise<TenantSettingsView>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; view: TenantSettingsView }
  | { status: 'error'; message: string };

export function SettingsView({ fetchFn }: Props = {}) {
  const fetcher = fetchFn ?? fetchTenantSettings;
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', view });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load settings.';
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  return (
    <section className="rc-stack">
      <PageHeader title="Settings" description="Tenant-wide configuration" />
      {state.status === 'loading' && (
        <p className="rc-muted-line">Loading settings…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
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
    </section>
  );
}
