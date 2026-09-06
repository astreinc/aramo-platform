import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import { SettingCardHead, StatChip } from '../settings/components';
import {
  disableIntegrationConnection,
  enableIntegrationConnection,
} from '../integrations/integrations-api';
import { getMicrosoftProviderStatus, type MicrosoftProviderStatus } from '../microsoft/microsoft-api';
import { ConfigureMicrosoftDialog } from '../microsoft/ConfigureMicrosoftDialog';

import { ConfigureZoomCredentialDialog } from './ConfigureZoomCredentialDialog';
import { RecruiterMappingsDialog } from './RecruiterMappingsDialog';
import { listCommunicationProviders, testZoomConnection } from './provider-config-api';
import type { CommunicationProviderConfig } from './provider-config-types';
import { COMMUNICATION_REGISTRY, readyProvider, type ChannelDef } from './communication-registry';

// COMM-C1 + PART C — Settings → Integrations → Communication channels. CHANNEL-FIRST
// (Architect channel/provider correction): the platform registry lists independent
// channels (Voice/Email/Meeting/SMS); each shows its selected/eligible provider,
// truthful Tenant configuration state, and only backed actions. One active provider
// per channel; a not-ready provider (Zoom Meetings, Zoom SMS) is shown as a disabled
// "future" option and is never selectable/configurable. Meeting reuses the Microsoft
// credential substrate but is an independent channel. Least-visibility: no
// `integration:read` → nothing renders and no fetch; `integration:write` gates
// Configure/Test/Change. A credential value is never shown.

interface Props {
  readonly sessionOverride?: Session;
  readonly listFn?: () => Promise<readonly CommunicationProviderConfig[]>;
  readonly microsoftStatusFn?: () => Promise<MicrosoftProviderStatus>;
  readonly testFn?: typeof testZoomConnection;
  readonly enableFn?: (id: string) => Promise<unknown>;
  readonly disableFn?: (id: string) => Promise<unknown>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; providers: readonly CommunicationProviderConfig[]; microsoft: MicrosoftProviderStatus | null }
  | { status: 'error' };

export function CommunicationsProvidersPanel({
  sessionOverride,
  listFn,
  microsoftStatusFn,
  testFn,
  enableFn,
  disableFn,
}: Props = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, 'integration:read');
  const canWrite = session != null && hasScope(session, 'integration:write');

  if (!canRead) return null;

  return (
    <Panel
      canWrite={canWrite}
      listFn={listFn ?? listCommunicationProviders}
      microsoftStatusFn={microsoftStatusFn ?? getMicrosoftProviderStatus}
      testFn={testFn ?? testZoomConnection}
      enableFn={enableFn ?? enableIntegrationConnection}
      disableFn={disableFn ?? disableIntegrationConnection}
    />
  );
}

interface ChannelView {
  readonly def: ChannelDef;
  readonly providerName: string | null;
  readonly configured: boolean;
  readonly connectionId: string | null;
  readonly status: CommunicationProviderConfig['status'] | null;
  readonly detail: string;
  readonly chip: { tone: 'ok' | 'warn' | 'muted'; label: string };
}

function deriveChannel(
  def: ChannelDef,
  providers: readonly CommunicationProviderConfig[],
  microsoft: MicrosoftProviderStatus | null,
): ChannelView {
  const ready = readyProvider(def);
  if (ready === null) {
    return {
      def,
      providerName: null,
      configured: false,
      connectionId: null,
      status: null,
      detail: 'No supported provider for this channel yet.',
      chip: { tone: 'muted', label: 'No provider available yet' },
    };
  }
  if (def.backend === 'zoom_phone') {
    const zoom = providers.find((p) => p.provider_key === 'zoom_phone') ?? null;
    const configured = zoom !== null && zoom.configuration_state !== 'not_configured';
    return {
      def,
      providerName: ready.name,
      configured,
      connectionId: zoom?.connection_id ?? null,
      status: zoom?.status ?? null,
      detail: configured
        ? `${ready.name} — ${zoom!.recruiter_mapping_count} recruiter mapping${zoom!.recruiter_mapping_count === 1 ? '' : 's'}`
        : `${ready.name} — Credential missing · 0 recruiter mappings`,
      chip: configured
        ? { tone: 'ok', label: 'Active' }
        : { tone: 'warn', label: 'Selected · not configured' },
    };
  }
  // Microsoft-backed (Email + Meeting share the substrate; independent channels).
  const configured = microsoft?.configuration_state === 'CONFIGURED';
  const attention = microsoft?.configuration_state === 'REQUIRES_ATTENTION';
  return {
    def,
    providerName: ready.name,
    configured,
    connectionId: microsoft?.connection_id ?? null,
    status: null,
    detail: configured ? `${ready.name} — Configured` : `${ready.name} — Not configured`,
    chip: configured
      ? { tone: 'ok', label: 'Active' }
      : attention
        ? { tone: 'warn', label: 'Requires attention' }
        : { tone: 'warn', label: 'Selected · not configured' },
  };
}

function Panel({
  canWrite,
  listFn,
  microsoftStatusFn,
  testFn,
  enableFn,
  disableFn,
}: {
  readonly canWrite: boolean;
  readonly listFn: () => Promise<readonly CommunicationProviderConfig[]>;
  readonly microsoftStatusFn: () => Promise<MicrosoftProviderStatus>;
  readonly testFn: () => Promise<{ healthy: boolean; detail: string | null }>;
  readonly enableFn: (id: string) => Promise<unknown>;
  readonly disableFn: (id: string) => Promise<unknown>;
}) {
  const toast = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [zoomConfigureOpen, setZoomConfigureOpen] = useState(false);
  const [microsoftConfigureOpen, setMicrosoftConfigureOpen] = useState(false);
  const [mappingsOpen, setMappingsOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    Promise.all([listFn(), microsoftStatusFn().catch(() => null)])
      .then(([providers, microsoft]) => {
        if (!cancelled) setLoad({ status: 'ready', providers, microsoft });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [listFn, microsoftStatusFn, refreshKey]);

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

  const microsoftStatus = load.status === 'ready' ? load.microsoft : null;

  return (
    <section data-testid="communications-providers" aria-label="Communication channels">
      <Card flush>
        <SettingCardHead
          title="Communication channels"
          sub="One active provider per channel. The list of channels and eligible providers is served by the platform registry — new providers appear when their connector ships. Credential values are never shown."
        />
        <div className="rc-card--pad">
          {load.status === 'loading' && <LoadingState label="Loading communication channels…" />}
          {load.status === 'error' && (
            <ErrorState message="Could not load communication channels." onRetry={refresh} />
          )}
          {load.status === 'ready' &&
            COMMUNICATION_REGISTRY.map((def) => {
              const view = deriveChannel(def, load.providers, load.microsoft);
              const anyReady = def.providers.some((p) => p.ready);
              return (
                <div
                  key={def.channel}
                  className="set-rows"
                  role="group"
                  aria-label={def.channel}
                  data-testid={`comm-channel-${def.channel}`}
                >
                  <div className="set-row">
                    <span className="set-row__l">
                      <span className="set-row__t">{def.channel}</span>
                      <span className="set-row__s" data-testid={`comm-channel-detail-${def.channel}`}>
                        {view.detail}
                      </span>
                    </span>
                    <span className="set-row__r" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span data-testid={`comm-channel-state-${def.channel}`}>
                        <StatChip tone={view.chip.tone} dot>
                          {view.chip.label}
                        </StatChip>
                      </span>
                      {canWrite && view.providerName !== null && view.def.backend !== null && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy}
                          data-testid={`comm-configure-${def.channel}`}
                          onClick={() =>
                            def.backend === 'zoom_phone'
                              ? setZoomConfigureOpen(true)
                              : setMicrosoftConfigureOpen(true)
                          }
                        >
                          {view.configured ? 'Update' : 'Configure'}
                        </Button>
                      )}
                      {canWrite && def.backend === 'zoom_phone' && (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy || !view.configured}
                            data-testid={`comm-test-${def.channel}`}
                            onClick={runTest}
                          >
                            Test connection
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy || !view.configured}
                            data-testid={`comm-mappings-${def.channel}`}
                            onClick={() => setMappingsOpen(true)}
                          >
                            Manage recruiter mappings
                          </Button>
                        </>
                      )}
                      {canWrite && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || !anyReady}
                          title={anyReady ? '' : 'No supported provider for this channel yet'}
                          data-testid={`comm-change-provider-${def.channel}`}
                          onClick={() => setPickerFor(pickerFor === def.channel ? null : def.channel)}
                        >
                          {view.providerName === null ? 'Choose provider' : 'Change provider'}
                        </Button>
                      )}
                    </span>
                  </div>

                  {pickerFor === def.channel && (
                    <div className="set-row" data-testid={`comm-picker-${def.channel}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                      <span className="set-row__s" style={{ fontWeight: 700 }}>
                        SELECT A PROVIDER — one active per channel
                      </span>
                      {def.providers.map((p) => (
                        <div
                          key={p.name}
                          data-testid={`comm-provider-option-${def.channel}-${p.initials}`}
                          style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: p.ready ? 1 : 0.55 }}
                        >
                          <input
                            type="radio"
                            name={`provider-${def.channel}`}
                            disabled={!p.ready}
                            checked={p.ready && p.name === view.providerName}
                            readOnly
                          />
                          <span style={{ flex: 1 }}>
                            <strong>{p.name}</strong>
                            <span className="set-row__s" style={{ display: 'block' }}>{p.note}</span>
                          </span>
                          <StatChip tone={p.ready ? 'ok' : 'muted'}>
                            {p.ready ? (p.name === view.providerName ? 'Selected' : 'Supported') : 'Future · not available yet'}
                          </StatChip>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </Card>

      <ConfigureZoomCredentialDialog
        open={zoomConfigureOpen}
        onOpenChange={setZoomConfigureOpen}
        onConfigured={() => refresh()}
      />
      <ConfigureMicrosoftDialog
        open={microsoftConfigureOpen}
        onOpenChange={setMicrosoftConfigureOpen}
        hasSecret={microsoftStatus?.configuration_state === 'CONFIGURED'}
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
