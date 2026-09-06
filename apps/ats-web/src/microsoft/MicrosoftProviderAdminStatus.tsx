import { useEffect, useState } from 'react';

import {
  getMicrosoftProviderStatus as defaultLoad,
  type MicrosoftProviderStatus,
} from './microsoft-api';

// COMM-C2B tenant-admin UX (C2B-8). Surfaces the Microsoft 365 provider's
// capability + recruiter identity mapping counts under Settings → Integrations →
// Communications. Provider-neutral counts; no token/secret.

export interface MicrosoftProviderAdminStatusProps {
  readonly loadFn?: () => Promise<MicrosoftProviderStatus>;
}

export function MicrosoftProviderAdminStatus(props: MicrosoftProviderAdminStatusProps): JSX.Element {
  const load = props.loadFn ?? defaultLoad;
  const [status, setStatus] = useState<MicrosoftProviderStatus | null>(null);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    let live = true;
    load()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        if (live) setConfigured(false);
      });
    return () => {
      live = false;
    };
  }, [load]);

  if (!configured) {
    return (
      <div data-testid="microsoft-provider-unconfigured">
        Microsoft 365 is not configured for this tenant.
      </div>
    );
  }
  if (status === null) {
    return <div data-testid="microsoft-provider-loading">Loading Microsoft 365 status…</div>;
  }

  return (
    <div data-testid="microsoft-provider-status">
      <h4>Microsoft 365</h4>
      <ul>
        <li data-testid="microsoft-cap-email">
          Email: {status.capabilities.email ? 'available' : 'unavailable'}
        </li>
        <li data-testid="microsoft-cap-meeting">
          Meeting: {status.capabilities.meeting ? 'available' : 'unavailable'}
        </li>
      </ul>
      <dl>
        <dt>Active recruiters</dt>
        <dd data-testid="microsoft-count-active">{status.identities.active}</dd>
        <dt>Reauthorization required</dt>
        <dd data-testid="microsoft-count-reauth">{status.identities.reauth_required}</dd>
        <dt>Disabled</dt>
        <dd data-testid="microsoft-count-disabled">{status.identities.disabled}</dd>
      </dl>
    </div>
  );
}
