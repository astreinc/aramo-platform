import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import { SettingCardHead, StatChip } from '../settings/components';

import {
  connectESignatureProvider as defaultConnect,
  disconnectESignatureProvider as defaultDisconnect,
  getESignatureOverview as defaultLoad,
  selectESignatureProvider as defaultSelect,
  type ESignatureOverview,
  type ESignatureProvider,
  type ESignatureProviderStatus,
  type SignatureAllowance,
} from './esignature-api';

// Multi-Provider E-Sign directive §E/§H — Settings → Integrations → E-Signature.
// One active provider per tenant. Least-visibility like its sibling panels:
//   - no `integration:read`  → renders nothing AND makes no fetch;
//   - read                   → active provider, provider statuses, allowance;
//   - `integration:write`    → change the active provider (audited server-side).
// External providers are never shown as connected before their integration
// exists; "not available yet" rows cannot be selected.

const META: Record<ESignatureProvider, { label: string; note: string; initials: string }> = {
  aramo_sign: { label: 'Aramo Sign', note: 'Built in · envelopes come from your Aramo plan', initials: 'AS' },
  docusign: { label: 'DocuSign', note: 'Your DocuSign account · its own plan and limits', initials: 'DS' },
  adobe_sign: { label: 'Adobe Acrobat Sign', note: 'Your Adobe account · its own plan and limits', initials: 'AD' },
};

const STATUS_TAG: Record<ESignatureProviderStatus, { tone: 'ok' | 'warn' | 'muted'; label: string }> = {
  BUILT_IN: { tone: 'muted', label: 'Built in' },
  CONNECTED: { tone: 'ok', label: 'Connected' },
  NOT_CONNECTED: { tone: 'warn', label: 'Not connected' },
  NOT_AVAILABLE: { tone: 'muted', label: 'Not available yet' },
};

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export function renewalDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

function AllowanceBlock({ allowance }: { readonly allowance: SignatureAllowance }) {
  const renews = renewalDate(allowance.period_end);
  // Commercial Plans Amendment A1 — an unlimited plan has no ceiling: show the
  // count only (no meter, no "left" or "used up" message).
  if (allowance.limit === null) {
    return (
      <div className="set-esign__allowance" data-testid="esign-allowance">
        <div className="set-esign__allowhead">
          <span className="set-esign__allowlabel">Envelopes this period</span>
          <span className="set-esign__allowcount">
            {allowance.used} sent · unlimited · period renews {renews}
          </span>
        </div>
      </div>
    );
  }
  const limit = allowance.limit;
  const pct = limit > 0 ? Math.min(100, Math.round((allowance.used / limit) * 100)) : 100;
  return (
    <div className="set-esign__allowance" data-testid="esign-allowance">
      <div className="set-esign__allowhead">
        <span className="set-esign__allowlabel">Envelopes this period</span>
        <span className="set-esign__allowcount">
          {allowance.used} of {limit} used · renews {renews}
        </span>
      </div>
      <div
        className={`set-esign__meter set-esign__meter--${allowance.threshold.toLowerCase()}`}
        role="progressbar"
        aria-label="Envelopes used this period"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={allowance.used}
      >
        <span className="set-esign__meterfill" style={{ width: `${pct}%` }} />
      </div>
      {allowance.threshold === 'WARNING' && (
        <p className="set-esign__msg set-esign__msg--warn" role="status">
          {allowance.remaining} envelopes left this period. New Aramo Sign sends stop when they run out, until {renews}.
        </p>
      )}
      {allowance.threshold === 'EXHAUSTED' && (
        <p className="set-esign__msg set-esign__msg--stop" role="alert">
          All {limit} envelopes are used. New Aramo Sign sends, including Right to Represent requests, are paused
          until {renews}. To send more before then, contact your Aramo account team to change your plan. Documents a
          client requires stay required.
        </p>
      )}
    </div>
  );
}

interface Props {
  readonly sessionOverride?: Session;
  readonly loadFn?: () => Promise<ESignatureOverview>;
  readonly selectFn?: (provider: ESignatureProvider) => Promise<ESignatureOverview>;
  readonly connectFn?: (provider: ESignatureProvider) => Promise<{ authorize_url: string }>;
  readonly disconnectFn?: (provider: ESignatureProvider) => Promise<ESignatureOverview>;
  /** Full-page navigation to the provider's sign-in (overridable in tests). */
  readonly navigate?: (url: string) => void;
  /** The ?esignature=<provider>-<outcome> flag the OAuth callback lands with. */
  readonly connectOutcome?: string | null;
}

function outcomeFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('esignature');
}

type State = { status: 'loading' } | { status: 'ready'; overview: ESignatureOverview } | { status: 'error'; message: string };

export function ESignatureProvidersPanel({ sessionOverride, loadFn, selectFn, connectFn, disconnectFn, navigate, connectOutcome }: Props) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const toast = useToast();
  const load = loadFn ?? defaultLoad;
  const doSelect = selectFn ?? defaultSelect;
  const doConnect = connectFn ?? defaultConnect;
  const doDisconnect = disconnectFn ?? defaultDisconnect;
  const go = navigate ?? ((url: string) => window.location.assign(url));
  const outcome = connectOutcome === undefined ? outcomeFromLocation() : connectOutcome;
  const canRead = session !== null && hasScope(session, 'integration:read');
  const canWrite = session !== null && hasScope(session, 'integration:write');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    load()
      .then((overview) => setState({ status: 'ready', overview }))
      .catch((e) => setState({ status: 'error', message: safeErrorMessage(e, 'Failed to load e-signature settings.') }));
  }, [load]);

  useEffect(() => {
    if (!canRead) return;
    refresh();
  }, [canRead, refresh]);

  // The provider's OAuth redirect lands back here with an outcome flag.
  useEffect(() => {
    if (!canRead || outcome === null) return;
    const [provider, result] = outcome.split('-') as [string, string];
    const label = provider in META ? META[provider as ESignatureProvider].label : 'The provider';
    toast.show(result === 'connected' ? `${label} is connected.` : `${label} could not be connected. Try again.`);
  }, [canRead, outcome]);

  if (!canRead) return null;

  const onSelect = async (provider: ESignatureProvider) => {
    setBusy(true);
    try {
      setState({ status: 'ready', overview: await doSelect(provider) });
      toast.show(`${META[provider].label} is now your e-signature provider. Documents already sent stay with their provider.`);
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to change the e-signature provider.'));
    } finally {
      setBusy(false);
    }
  };

  const onConnect = async (provider: ESignatureProvider) => {
    setBusy(true);
    try {
      const { authorize_url } = await doConnect(provider);
      go(authorize_url);
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Could not start connecting.'));
      setBusy(false);
    }
  };

  const onDisconnect = async (provider: ESignatureProvider) => {
    setBusy(true);
    try {
      setState({ status: 'ready', overview: await doDisconnect(provider) });
      toast.show(`${META[provider].label} is disconnected.`);
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Could not disconnect.'));
    } finally {
      setBusy(false);
    }
  };

  const overview = state.status === 'ready' ? state.overview : null;
  const availability = overview?.availability ?? null;
  const activeLabel = overview !== null ? META[overview.active_provider].label : '';
  const headTag =
    availability === null
      ? null
      : availability.available
        ? { tone: 'ok' as const, label: `Ready · ${activeLabel}` }
        : availability.reason === 'LIMIT_REACHED'
          ? { tone: 'warn' as const, label: `Allowance used · ${activeLabel}` }
          : availability.reason === 'NOT_SUBSCRIBED'
            ? { tone: 'warn' as const, label: `Not in your plan · ${activeLabel}` }
            : { tone: 'warn' as const, label: `Unavailable · ${activeLabel}` };

  return (
    <Card>
      <SettingCardHead
        title={
          <span className="set-llm__head">
            E-signature provider
            {headTag !== null && (
              <StatChip tone={headTag.tone} dot>
                {headTag.label}
              </StatChip>
            )}
          </span>
        }
        sub="The provider Aramo uses to send Right to Represent requests, offer letters and other documents for signature. One provider is active at a time; documents already sent stay with the provider they were sent through."
      />
      {state.status === 'loading' && <LoadingState label="Loading e-signature settings…" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={refresh} />}
      {state.status === 'ready' && (
        <div className="rc-stack">
          <fieldset className="set-llm" data-testid="esign-active-provider">
            <legend>Active provider</legend>
            {state.overview.providers.map((p) => {
              const meta = META[p.provider];
              const active = state.overview.active_provider === p.provider;
              const tag = active ? { tone: 'ok' as const, label: 'ACTIVE' } : STATUS_TAG[p.status];
              return (
                <label key={p.provider} className={`set-llm__row${active ? ' set-llm__row--active' : ''}${p.selectable ? '' : ' set-llm__row--soon'}`}>
                  {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native radio kept for a11y + tests; visually replaced by .set-llm__dot */}
                  <input
                    type="radio"
                    name="esign-active-provider"
                    className="set-llm__radio"
                    value={p.provider}
                    checked={active}
                    disabled={!canWrite || busy || !p.selectable}
                    onChange={() => onSelect(p.provider)}
                    data-testid={`esign-provider-${p.provider}`}
                  />
                  <span className="set-llm__dot" aria-hidden="true" />
                  <span className={`set-llm__av set-esign__av--${p.provider}`} aria-hidden="true">
                    {meta.initials}
                  </span>
                  <span className="set-llm__body">
                    <span className="set-llm__name">{meta.label}</span>
                    <span className="set-llm__note">{meta.note}</span>
                  </span>
                  <span className="set-llm__tag" data-testid={`esign-status-${p.provider}`}>
                    <StatChip tone={p.needs_reconnect ? 'warn' : tag.tone}>{p.needs_reconnect ? 'Reconnect needed' : tag.label}</StatChip>
                  </span>
                  {canWrite && p.connectable && (
                    <span className="set-esign__actions">
                      {p.status === 'CONNECTED' ? (
                        <Button variant="secondary" disabled={busy} onClick={() => onDisconnect(p.provider)} data-testid={`esign-disconnect-${p.provider}`}>
                          Disconnect
                        </Button>
                      ) : (
                        <Button disabled={busy} onClick={() => onConnect(p.provider)} data-testid={`esign-connect-${p.provider}`}>
                          {p.needs_reconnect ? 'Reconnect' : 'Connect'}
                        </Button>
                      )}
                    </span>
                  )}
                </label>
              );
            })}
          </fieldset>

          {state.overview.active_provider === 'aramo_sign' && availability?.reason === 'NOT_SUBSCRIBED' && (
            <p className="set-esign__msg set-esign__msg--stop" role="alert" data-testid="esign-not-subscribed">
              Aramo Sign isn&apos;t part of your plan yet, so documents can&apos;t be sent for signature. Contact your Aramo
              account team to add it.
            </p>
          )}
          {state.overview.active_provider === 'aramo_sign' && availability?.allowance != null && (
            <AllowanceBlock allowance={availability.allowance} />
          )}
        </div>
      )}
    </Card>
  );
}
