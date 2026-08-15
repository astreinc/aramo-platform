import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, type Session } from '@aramo/fe-foundation';

import { Button, Card } from '../ui';
import { SettingCardHead } from '../settings/components';

import { IntegrationConnectionStatusPill } from './IntegrationConnectionStatusPill';
import {
  disableIntegrationConnection,
  enableIntegrationConnection,
  listIntegrationConnections,
} from './integrations-api';
import type { IntegrationConnectionView } from './types';

// T8-CONNECTOR-A — connector connection MANAGEMENT panel (Settings →
// Integrations sibling to the P3 monitoring view). Least-visibility:
//   - no `integration:read`  → renders nothing AND makes no fetch;
//   - read only              → status/config visibility, NO write controls;
//   - `integration:write`    → enable/disable affordances.
// A credential VALUE is never rendered — only whether one exists (`has_secret`).
// This panel is INDEPENDENT of the P3 `requisition:import:read` monitoring gate.

interface Props {
  readonly sessionOverride?: Session;
  readonly listFn?: () => Promise<readonly IntegrationConnectionView[]>;
  readonly enableFn?: (id: string) => Promise<IntegrationConnectionView>;
  readonly disableFn?: (id: string) => Promise<IntegrationConnectionView>;
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly IntegrationConnectionView[] }
  | { status: 'error'; message: string };

export function IntegrationConnectionsPanel({
  sessionOverride,
  listFn,
  enableFn,
  disableFn,
}: Props = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, 'integration:read');
  const canWrite = session != null && hasScope(session, 'integration:write');

  // Least-visibility: no surface and NO fetch when the read scope is absent.
  if (!canRead) return null;

  return (
    <Panel
      canWrite={canWrite}
      listFn={listFn ?? listIntegrationConnections}
      enableFn={enableFn ?? enableIntegrationConnection}
      disableFn={disableFn ?? disableIntegrationConnection}
    />
  );
}

function Panel({
  canWrite,
  listFn,
  enableFn,
  disableFn,
}: {
  readonly canWrite: boolean;
  readonly listFn: () => Promise<readonly IntegrationConnectionView[]>;
  readonly enableFn: (id: string) => Promise<IntegrationConnectionView>;
  readonly disableFn: (id: string) => Promise<IntegrationConnectionView>;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [list, setList] = useState<ListState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    listFn()
      .then((items) => {
        if (!cancelled) setList({ status: 'ready', items });
      })
      .catch(() => {
        if (!cancelled)
          setList({ status: 'error', message: 'Could not load connector connections.' });
      });
    return () => {
      cancelled = true;
    };
  }, [listFn, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const act = useCallback(
    async (fn: (id: string) => Promise<IntegrationConnectionView>, id: string) => {
      try {
        await fn(id);
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  return (
    <section data-testid="integration-connections" aria-label="Connector connections">
      <Card flush>
        <SettingCardHead
          title="Connector connections"
          sub="Administer provider-neutral connector connections. Credential values are never shown."
        />
        <div className="rc-card--pad">
          {list.status === 'loading' && (
            <p className="set-muted" data-testid="integration-loading">
              Loading connections…
            </p>
          )}
          {list.status === 'error' && (
            <p className="set-muted" role="alert" data-testid="integration-error">
              {list.message}
            </p>
          )}
          {list.status === 'ready' && list.items.length === 0 && (
            <p className="set-muted" data-testid="integration-empty">
              No connector connections have been configured yet.
            </p>
          )}
          {list.status === 'ready' && list.items.length > 0 && (
            <div className="set-rows" role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {list.items.map((c) => (
                <div role="listitem" key={c.id} data-testid={`integration-connection-${c.id}`}>
                  <div className="set-row">
                    <span className="set-row__l">
                      <span className="set-row__t">{c.provider_key}</span>
                      <span className="set-row__s">
                        {c.has_secret ? 'Credential configured' : 'No credential'}
                        {c.last_error_code != null ? ` · ${c.last_error_code}` : ''}
                      </span>
                    </span>
                    <span className="set-row__r">
                      <IntegrationConnectionStatusPill status={c.status} />
                      {canWrite && c.status !== 'disabled' && c.status !== 'active' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          data-testid={`integration-enable-${c.id}`}
                          onClick={() => act(enableFn, c.id)}
                        >
                          Enable
                        </Button>
                      )}
                      {canWrite && c.status !== 'disabled' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          data-testid={`integration-disable-${c.id}`}
                          onClick={() => act(disableFn, c.id)}
                        >
                          Disable
                        </Button>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
