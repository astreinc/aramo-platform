import { useEffect, useState } from 'react';

import { InlineAlert } from '../components/InlineAlert';
import { PageHeader } from '../components/PageHeader';

import { CompensationDisplayPicker } from './CompensationDisplayPicker';
import { FinancialsToggle } from './FinancialsToggle';
import { fetchTenantSettings } from './settings-api';
import type { TenantSettingsView } from './types';

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
    <section>
      <PageHeader
        title="Settings"
        description="Tenant-wide configuration"
      />
      {state.status === 'loading' && (
        <p className="tc-helper">Loading settings…</p>
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
