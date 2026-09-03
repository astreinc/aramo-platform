import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, EmptyState, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import { SettingCardHead, StatChip } from '../settings/components';
import { IntegrationConnectionStatusPill } from '../integrations/IntegrationConnectionStatusPill';
import {
  disableIntegrationConnection,
  enableIntegrationConnection,
} from '../integrations/integrations-api';

import { ConfigureZoomCredentialDialog } from './ConfigureZoomCredentialDialog';
import { RecruiterMappingsDialog } from './RecruiterMappingsDialog';
import { listCommunicationProviders, testZoomConnection } from './provider-config-api';
import type { CommunicationProviderConfig } from './provider-config-types';

// COMM-C1 — Settings → Integrations → Communications. Tenant communication
// provider configuration + admin UI (Zoom-only in PR-1). Least-visibility,
// mirroring IntegrationConnectionsPanel:
//   - no `integration:read`  → renders nothing AND makes no fetch;
//   - read only              → status/capability visibility, NO write controls;
//   - `integration:write`    → configure/test/mapping/enable-disable affordances.
// A credential VALUE is never rendered — only whether one exists
// (`credential_configured`). SMS is shown as declared / execution-deferred; no
// Send affordance is offered. This surface changes NO recruiting behaviour.

interface Props {
  readonly sessionOverride?: Session;
  readonly listFn?: () => Promise<readonly CommunicationProviderConfig[]>;
  readonly testFn?: typeof testZoomConnection;
  readonly enableFn?: (id: string) => Promise<unknown>;
  readonly disableFn?: (id: string) => Promise<unknown>;
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly CommunicationProviderConfig[] }
  | { status: 'error' };

export function CommunicationsProvidersPanel({
  sessionOverride,
  listFn,
  testFn,
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
      listFn={listFn ?? listCommunicationProviders}
      testFn={testFn ?? testZoomConnection}
      enableFn={enableFn ?? enableIntegrationConnection}
      disableFn={disableFn ?? disableIntegrationConnection}
    />
  );
}

function Panel({
  canWrite,
  listFn,
  testFn,
  enableFn,
  disableFn,
}: {
  readonly canWrite: boolean;
  readonly listFn: () => Promise<readonly CommunicationProviderConfig[]>;
  readonly testFn: () => Promise<{ healthy: boolean; detail: string | null }>;
  readonly enableFn: (id: string) => Promise<unknown>;
  readonly disableFn: (id: string) => Promise<unknown>;
}) {
  const toast = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [mappingsOpen, setMappingsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    listFn()
      .then((items) => {
        if (!cancelled) setList({ status: 'ready', items });
      })
      .catch(() => {
        if (!cancelled) setList({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [listFn, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const runTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await testFn();
      toast.show(
        result.healthy
          ? 'Connection test passed (structural check).'
          : `Connection not ready${result.detail != null ? `: ${result.detail}` : ''}.`,
      );
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not test the connection.'));
    } finally {
      setBusy(false);
    }
  }, [busy, testFn, toast]);

  const runLifecycle = useCallback(
    async (fn: (id: string) => Promise<unknown>, id: string, ok: string, fail: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn(id);
        toast.show(ok);
        refresh();
      } catch (err) {
        toast.show(safeErrorMessage(err, fail));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, toast],
  );

  return (
    <section data-testid="communications-providers" aria-label="Communications providers">
      <Card flush>
        <SettingCardHead
          title="Communications"
          sub="Configure the communication providers your team uses. Credential values are never shown."
        />
        <div className="rc-card--pad">
          {list.status === 'loading' && <LoadingState label="Loading communication providers…" />}
          {list.status === 'error' && (
            <ErrorState message="Could not load communication providers." onRetry={refresh} />
          )}
          {list.status === 'ready' && list.items.length === 0 && (
            <EmptyState message="No communication providers are available." />
          )}
          {list.status === 'ready' &&
            list.items.map((p) => (
              <ProviderCard
                key={p.provider_key}
                provider={p}
                canWrite={canWrite}
                busy={busy}
                onConfigure={() => setConfigureOpen(true)}
                onTest={runTest}
                onManageMappings={() => setMappingsOpen(true)}
                onEnable={() =>
                  p.connection_id != null &&
                  runLifecycle(
                    enableFn,
                    p.connection_id,
                    'Provider connection enabled.',
                    'Could not enable the connection.',
                  )
                }
                onDisable={() =>
                  p.connection_id != null &&
                  runLifecycle(
                    disableFn,
                    p.connection_id,
                    'Provider connection disabled.',
                    'Could not disable the connection.',
                  )
                }
              />
            ))}
        </div>
      </Card>

      <ConfigureZoomCredentialDialog
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        onConfigured={() => refresh()}
      />
      <RecruiterMappingsDialog
        open={mappingsOpen}
        onOpenChange={setMappingsOpen}
        canWrite={canWrite}
        onChanged={() => refresh()}
      />
    </section>
  );
}

function ProviderCard({
  provider,
  canWrite,
  busy,
  onConfigure,
  onTest,
  onManageMappings,
  onEnable,
  onDisable,
}: {
  readonly provider: CommunicationProviderConfig;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly onConfigure: () => void;
  readonly onTest: () => void;
  readonly onManageMappings: () => void;
  readonly onEnable: () => void;
  readonly onDisable: () => void;
}) {
  const p = provider;
  const configured = p.status !== null && p.configuration_state !== 'not_configured';
  return (
    <div className="set-rows" role="group" aria-label={p.display_name} data-testid={`comm-provider-${p.provider_key}`}>
      <div className="set-row">
        <span className="set-row__l">
          <span className="set-row__t">{p.display_name}</span>
          <span className="set-row__s">
            {p.credential_configured ? 'Credential configured' : 'Credential missing'}
            {p.provider_account_id != null ? ` · account ${p.provider_account_id}` : ''}
            {p.last_error_code != null ? ` · ${p.last_error_code}` : ''}
          </span>
        </span>
        <span className="set-row__r">
          {p.status !== null ? (
            <IntegrationConnectionStatusPill status={p.status} />
          ) : (
            <StatChip tone="muted" dot>
              Not configured
            </StatChip>
          )}
        </span>
      </div>

      {/* Capability posture — voice executable; SMS declared / execution deferred. */}
      <div className="set-row">
        <span className="set-row__l">
          <span className="set-row__t">Capabilities</span>
          <span className="set-row__s" data-testid={`comm-caps-${p.provider_key}`}>
            {p.capabilities.voice.supported
              ? `Voice — ${p.capabilities.voice.execution === 'available' ? 'Available' : 'Not available'}`
              : 'Voice — Not supported'}
            {p.capabilities.sms.supported
              ? ' · SMS — Declared / execution deferred'
              : ''}
          </span>
        </span>
        <span className="set-row__r">
          <StatChip tone="muted">{`${p.recruiter_mapping_count} recruiter mapping${p.recruiter_mapping_count === 1 ? '' : 's'}`}</StatChip>
        </span>
      </div>

      {canWrite && (
        <div className="set-row">
          <span className="set-row__l" />
          <span className="set-row__r" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button variant="secondary" size="sm" disabled={busy} onClick={onConfigure} data-testid={`comm-configure-${p.provider_key}`}>
              {p.credential_configured ? 'Update credentials' : 'Configure'}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || !configured} onClick={onTest} data-testid={`comm-test-${p.provider_key}`}>
              Test connection
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || !configured} onClick={onManageMappings} data-testid={`comm-mappings-${p.provider_key}`}>
              Manage recruiter mappings
            </Button>
            {p.connection_id != null && p.status !== 'active' && p.status !== 'disabled' && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={onEnable} data-testid={`comm-enable-${p.provider_key}`}>
                Enable
              </Button>
            )}
            {p.connection_id != null && p.status !== 'disabled' && p.status !== null && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={onDisable} data-testid={`comm-disable-${p.provider_key}`}>
                Disable
              </Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
