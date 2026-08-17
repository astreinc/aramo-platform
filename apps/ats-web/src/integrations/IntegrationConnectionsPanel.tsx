import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session } from '@aramo/fe-foundation';

import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  safeErrorMessage,
} from '../ui';
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
  const toast = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  // The single in-flight mutation's connection id (T10-B2/F-021): its controls
  // disable and a second mutation is blocked until it settles.
  const [busyId, setBusyId] = useState<string | null>(null);
  // The connection queued for a destructive disable confirmation.
  const [confirmDisable, setConfirmDisable] =
    useState<IntegrationConnectionView | null>(null);

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

  // T10-B2/F-021 — the connector mutation UX standard: single-flight (blocks
  // duplicate/concurrent submits), safe error surfaced via toast (never a raw
  // exception), success toast + authoritative server re-read.
  const runMutation = useCallback(
    async (
      fn: (id: string) => Promise<IntegrationConnectionView>,
      id: string,
      successMsg: string,
      failMsg: string,
    ) => {
      if (busyId !== null) return;
      setBusyId(id);
      try {
        await fn(id);
        toast.show(successMsg);
        refresh();
      } catch (err) {
        toast.show(safeErrorMessage(err, failMsg));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh, toast],
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
            <LoadingState label="Loading connections…" />
          )}
          {list.status === 'error' && (
            <ErrorState message={list.message} onRetry={refresh} />
          )}
          {list.status === 'ready' && list.items.length === 0 && (
            <EmptyState message="No connector connections have been configured yet." />
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
                          disabled={busyId !== null}
                          data-testid={`integration-enable-${c.id}`}
                          onClick={() =>
                            runMutation(
                              enableFn,
                              c.id,
                              'Connector connection enabled.',
                              'Could not enable the connection. Try again.',
                            )
                          }
                        >
                          {busyId === c.id ? 'Working…' : 'Enable'}
                        </Button>
                      )}
                      {canWrite && c.status !== 'disabled' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyId !== null}
                          data-testid={`integration-disable-${c.id}`}
                          onClick={() => setConfirmDisable(c)}
                        >
                          {busyId === c.id ? 'Working…' : 'Disable'}
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

      {/* T10-B2/F-021 D — destructive disable confirmation via the shared
          Dialog. Enable is non-destructive (no confirm). Existing scopes are
          unchanged; no provider selection / onboarding is implied. */}
      <Dialog
        open={confirmDisable !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDisable(null);
        }}
        title="Disable this connection?"
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmDisable(null)}
              data-testid="integration-disable-cancel"
            >
              Keep enabled
            </Button>
            <Button
              variant="primary"
              disabled={busyId !== null}
              data-testid="integration-disable-confirm"
              onClick={() => {
                const target = confirmDisable;
                setConfirmDisable(null);
                if (target !== null)
                  void runMutation(
                    disableFn,
                    target.id,
                    'Connector connection disabled.',
                    'Could not disable the connection. Try again.',
                  );
              }}
            >
              Disable
            </Button>
          </>
        }
      >
        <p>
          The connector stops syncing until it is re-enabled. Stored credentials
          are kept.
        </p>
      </Dialog>
    </section>
  );
}
