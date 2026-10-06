import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session, Input, IconShield } from '@aramo/fe-foundation';

import { Button, Card, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import { SettingCardHead, StatChip } from '../settings/components';

import {
  clearProviderKey as defaultClear,
  getLlmOverview as defaultLoad,
  setActiveProvider as defaultSetActive,
  setProviderKey as defaultSetKey,
  type LlmProvider,
  type TenantLlmOverview,
} from './llm-providers-api';

// TENANT-LLM-2 — Settings → Integrations → AI/LLM. Multi-provider BYO: the tenant
// picks an ACTIVE provider and supplies that provider's OWN key. Least-visibility,
// mirroring the connector panel:
//   - no `integration:read`  → renders nothing AND makes no fetch;
//   - read only              → shows the active provider + per-provider status;
//   - `integration:write`    → select-provider + Set / Rotate / Clear for the
//                              active provider's key.
// WRITE-ONLY: key values are never fetched or displayed — only the has-key boolean.
//
// The SELECTABLE providers come from the server overview (the wired set — no dead
// knobs). Unwired providers render as static, disabled "coming soon" rows, never
// selectable. The key controls target the ACTIVE provider (select a provider to
// manage its key); the endpoints stay per-provider and write-only.

interface ProviderMeta {
  readonly label: string;
  readonly note: string;
  readonly initials: string;
  readonly av: string;
}

const PROVIDER_META: Record<LlmProvider, ProviderMeta> = {
  anthropic: {
    label: 'Anthropic',
    note: 'Claude · governed extraction reference models',
    initials: 'AN',
    av: 'anthropic',
  },
  openai: {
    label: 'OpenAI',
    note: 'GPT-4 class · direct API key',
    initials: 'OA',
    av: 'openai',
  },
};

const COMING_SOON: ReadonlyArray<{ key: string; label: string; note: string; initials: string; av: string }> = [
  {
    key: 'azure',
    label: 'Azure OpenAI',
    note: 'Your Azure subscription · regional data residency',
    initials: 'AZ',
    av: 'azure',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    note: 'Gemini API via Google AI Studio or Vertex',
    initials: 'GG',
    av: 'gemini',
  },
  {
    key: 'bedrock',
    label: 'AWS Bedrock',
    note: 'Anthropic/other models inside your AWS account',
    initials: 'BR',
    av: 'bedrock',
  },
];

const KEY_PLACEHOLDER: Record<LlmProvider, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
};

interface Props {
  readonly sessionOverride?: Session;
  readonly loadFn?: () => Promise<TenantLlmOverview>;
  readonly setActiveFn?: (provider: LlmProvider) => Promise<TenantLlmOverview>;
  readonly setKeyFn?: (provider: LlmProvider, apiKey: string) => Promise<{ configured: boolean }>;
  readonly clearFn?: (provider: LlmProvider) => Promise<{ configured: boolean }>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; overview: TenantLlmOverview }
  | { status: 'error'; message: string };

export function LlmProvidersPanel({ sessionOverride, loadFn, setActiveFn, setKeyFn, clearFn }: Props) {
  const sessionState = useSession();
  const session =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const toast = useToast();
  const load = loadFn ?? defaultLoad;
  const doSetActive = setActiveFn ?? defaultSetActive;
  const doSetKey = setKeyFn ?? defaultSetKey;
  const doClear = clearFn ?? defaultClear;

  const canRead = session !== null && hasScope(session, 'integration:read');
  const canWrite = session !== null && hasScope(session, 'integration:write');

  const [state, setState] = useState<State>({ status: 'loading' });
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    load()
      .then((overview) => setState({ status: 'ready', overview }))
      .catch((e) => setState({ status: 'error', message: safeErrorMessage(e, 'Failed to load status.') }));
  }, [load]);

  useEffect(() => {
    if (!canRead) return;
    refresh();
  }, [canRead, refresh]);

  // Least-visibility: absent read scope → render nothing AND make no fetch.
  if (!canRead) return null;

  const onSelectActive = async (provider: LlmProvider) => {
    setBusy(true);
    try {
      const overview = await doSetActive(provider);
      setState({ status: 'ready', overview });
      toast.show(`${PROVIDER_META[provider].label} is now the active provider.`);
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to select provider.'));
    } finally {
      setBusy(false);
    }
  };

  const onSaveKey = async (provider: LlmProvider) => {
    const draft = draftKeys[provider] ?? '';
    if (draft.length === 0) return;
    setBusy(true);
    try {
      await doSetKey(provider, draft);
      setDraftKeys((d) => ({ ...d, [provider]: '' })); // never retain the value
      toast.show(`${PROVIDER_META[provider].label} key saved.`);
      refresh();
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to save key.'));
      setBusy(false);
    }
  };

  const onClearKey = async (provider: LlmProvider) => {
    setBusy(true);
    try {
      await doClear(provider);
      toast.show(`${PROVIDER_META[provider].label} key cleared.`);
      refresh();
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to clear key.'));
      setBusy(false);
    }
  };

  const overview = state.status === 'ready' ? state.overview : null;
  const activeProvider = overview?.active_provider ?? null;
  const activeStatus = overview?.providers.find((p) => p.provider === activeProvider) ?? null;
  const activeConfigured = activeStatus?.configured ?? false;
  const activeLabel = activeProvider !== null ? (PROVIDER_META[activeProvider]?.label ?? activeProvider) : '';

  return (
    <Card>
      <SettingCardHead
        title={
          <span className="set-llm__head">
            AI / LLM provider
            {overview !== null && (
              <StatChip tone={activeConfigured ? 'ok' : 'warn'} dot>
                {activeConfigured ? `Configured · ${activeLabel}` : `Key required · ${activeLabel}`}
              </StatChip>
            )}
          </span>
        }
        sub="Your tenant's own model provider and API key power governed resume extraction and other AI features. Bring your own key from any supported provider — the key is stored securely, never displayed after saving, and Aramo never falls back to a shared platform key."
      />
      {state.status === 'loading' && <LoadingState label="Loading status…" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={refresh} />}
      {state.status === 'ready' && (
        <div className="rc-stack">
          <fieldset className="set-llm" data-testid="llm-active-provider">
            <legend>Active provider</legend>
            {state.overview.providers.map((p) => {
              const meta = PROVIDER_META[p.provider];
              const active = state.overview.active_provider === p.provider;
              const tag: { tone: 'ok' | 'warn' | 'muted'; label: string } = active
                ? p.configured
                  ? { tone: 'ok', label: 'ACTIVE · CONFIGURED' }
                  : { tone: 'warn', label: 'ACTIVE · KEY NEEDED' }
                : { tone: 'muted', label: p.configured ? 'Configured' : 'Supported' };
              return (
                <label key={p.provider} className={`set-llm__row${active ? ' set-llm__row--active' : ''}`}>
                  {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native radio kept for a11y + tests; visually replaced by .set-llm__dot */}
                  <input
                    type="radio"
                    name="llm-active-provider"
                    className="set-llm__radio"
                    value={p.provider}
                    checked={active}
                    disabled={!canWrite || busy}
                    onChange={() => onSelectActive(p.provider)}
                    data-testid={`llm-active-${p.provider}`}
                  />
                  <span className="set-llm__dot" aria-hidden="true" />
                  <span className={`set-llm__av set-llm__av--${meta.av}`} aria-hidden="true">
                    {meta.initials}
                  </span>
                  <span className="set-llm__body">
                    <span className="set-llm__name">{meta.label}</span>
                    <span className="set-llm__note">{meta.note}</span>
                  </span>
                  <span className="set-llm__tag" data-testid={`llm-status-${p.provider}`}>
                    <StatChip tone={tag.tone}>{tag.label}</StatChip>
                  </span>
                </label>
              );
            })}
            {COMING_SOON.map((cs) => (
              <label key={cs.key} className="set-llm__row set-llm__row--soon">
                {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: disabled native radio kept for a11y + tests (unwired = never selectable) */}
                <input
                  type="radio"
                  name="llm-active-provider"
                  className="set-llm__radio"
                  disabled
                  data-testid={`llm-comingsoon-${cs.key}`}
                />
                <span className="set-llm__dot" aria-hidden="true" />
                <span className={`set-llm__av set-llm__av--${cs.av}`} aria-hidden="true">
                  {cs.initials}
                </span>
                <span className="set-llm__body">
                  <span className="set-llm__name">{cs.label}</span>
                  <span className="set-llm__note">{cs.note}</span>
                </span>
                <span className="set-llm__tag">
                  <StatChip tone="muted">Supported</StatChip>
                </span>
              </label>
            ))}
          </fieldset>

          {canWrite && activeProvider !== null && (
            <div className="set-llm__key" data-testid={`llm-key-block-${activeProvider}`}>
              <div className="set-llm__keyhead">
                <span className="set-llm__keylabel">API key</span>
                <span className="set-llm__keysub">
                  ·{' '}
                  {activeConfigured
                    ? `a key is on file for ${activeLabel}`
                    : `no key on file for ${activeLabel} yet`}
                </span>
              </div>
              <div className="set-llm__keyrow">
                <Input
                  unstyled
                  type="password"
                  autoComplete="off"
                  className="set-llm__keyinput"
                  placeholder={
                    activeConfigured ? 'Enter a new key to rotate' : (KEY_PLACEHOLDER[activeProvider] ?? 'key')
                  }
                  value={draftKeys[activeProvider] ?? ''}
                  onChange={(e) => setDraftKeys((d) => ({ ...d, [activeProvider]: e.target.value }))}
                  data-testid={`llm-key-input-${activeProvider}`}
                />
                <Button
                  onClick={() => onSaveKey(activeProvider)}
                  disabled={busy || (draftKeys[activeProvider] ?? '').length === 0}
                  data-testid={`llm-key-save-${activeProvider}`}
                >
                  {activeConfigured ? 'Rotate key' : 'Save key'}
                </Button>
                {activeConfigured && (
                  <Button
                    variant="secondary"
                    onClick={() => onClearKey(activeProvider)}
                    disabled={busy}
                    data-testid={`llm-key-clear-${activeProvider}`}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <div className="set-llm__secure">
                <IconShield />
                <span>
                  Keys are tenant-scoped and stored in the platform vault under your tenant. Switching
                  providers keeps the previous key in custody until you clear it; the switch is versioned
                  and logged. Resume data is sent only to the provider you select here.
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
