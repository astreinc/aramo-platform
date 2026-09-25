import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session, Input } from '@aramo/fe-foundation';

import { Button, Card, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import { SettingCardHead } from '../settings/components';

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
//   - `integration:write`    → select-provider + Set / Rotate / Clear per provider.
// WRITE-ONLY: key values are never fetched or displayed — only the has-key boolean.
//
// The SELECTABLE providers come from the server overview (the wired set — no dead
// knobs). Unwired providers render as static "coming soon", never selectable.

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

const COMING_SOON: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'azure', label: 'Azure OpenAI' },
  { key: 'gemini', label: 'Google Gemini' },
  { key: 'bedrock', label: 'AWS Bedrock' },
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
      toast.show(`${PROVIDER_LABEL[provider]} is now the active provider.`);
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
      toast.show(`${PROVIDER_LABEL[provider]} key saved.`);
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
      toast.show(`${PROVIDER_LABEL[provider]} key cleared.`);
      refresh();
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to clear key.'));
      setBusy(false);
    }
  };

  return (
    <Card>
      <SettingCardHead
        title="AI / LLM provider"
        sub="Bring your own model provider. Aramo routes every governed AI feature (résumé extraction and more) to your tenant's active provider using your own key. Keys are stored securely and never displayed after saving. Aramo never falls back to a shared key or another provider."
      />
      {state.status === 'loading' && <LoadingState label="Loading status…" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={refresh} />}
      {state.status === 'ready' && (
        <div className="rc-stack">
          <fieldset className="rc-fieldset" data-testid="llm-active-provider">
            <legend className="rc-field-label">Active provider</legend>
            {state.overview.providers.map((p) => (
              <label key={p.provider} className="rc-radio-row">
                {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native radio in a custom per-row layout; no clean fe-foundation RadioGroup mapping without redesign */}
                <input
                  type="radio"
                  name="llm-active-provider"
                  value={p.provider}
                  checked={state.overview.active_provider === p.provider}
                  disabled={!canWrite || busy}
                  onChange={() => onSelectActive(p.provider)}
                  data-testid={`llm-active-${p.provider}`}
                />
                <span>{PROVIDER_LABEL[p.provider] ?? p.provider}</span>
                <span className="rc-muted-line" data-testid={`llm-status-${p.provider}`}>
                  {p.configured ? 'Configured' : 'Not configured'}
                </span>
              </label>
            ))}
            {COMING_SOON.map((cs) => (
              <label key={cs.key} className="rc-radio-row rc-muted-line">
                {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native radio in a custom per-row layout; no clean fe-foundation RadioGroup mapping without redesign */}
                <input type="radio" name="llm-active-provider" disabled data-testid={`llm-comingsoon-${cs.key}`} />
                <span>{cs.label}</span>
                <span className="rc-muted-line">Coming soon</span>
              </label>
            ))}
          </fieldset>

          {canWrite &&
            state.overview.providers.map((p) => (
              <div key={p.provider} className="rc-stack" data-testid={`llm-key-block-${p.provider}`}>
                <label className="rc-field">
                  <span className="rc-field-label">{PROVIDER_LABEL[p.provider] ?? p.provider} API key</span>
                  <Input unstyled
                    type="password"
                    autoComplete="off"
                    className="rc-input"
                    placeholder={p.configured ? 'Enter a new key to rotate' : (KEY_PLACEHOLDER[p.provider] ?? 'key')}
                    value={draftKeys[p.provider] ?? ''}
                    onChange={(e) => setDraftKeys((d) => ({ ...d, [p.provider]: e.target.value }))}
                    data-testid={`llm-key-input-${p.provider}`}
                  />
                </label>
                <div className="rc-row">
                  <Button
                    onClick={() => onSaveKey(p.provider)}
                    disabled={busy || (draftKeys[p.provider] ?? '').length === 0}
                    data-testid={`llm-key-save-${p.provider}`}
                  >
                    {p.configured ? 'Rotate key' : 'Set key'}
                  </Button>
                  {p.configured && (
                    <Button
                      variant="secondary"
                      onClick={() => onClearKey(p.provider)}
                      disabled={busy}
                      data-testid={`llm-key-clear-${p.provider}`}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
