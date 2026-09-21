import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import { SettingCardHead } from '../settings/components';

import {
  clearAnthropicKey as defaultClear,
  getAnthropicKeyStatus as defaultLoad,
  setAnthropicKey as defaultSet,
  type TenantLlmKeyStatus,
} from './anthropic-llm-api';

// TENANT-LLM-1 — Settings → Integrations → AI/LLM → Anthropic. The tenant's OWN
// Anthropic key (BYO). Least-visibility, mirroring the connector panel:
//   - no `integration:read`  → renders nothing AND makes no fetch;
//   - read only              → shows Configured / Not configured;
//   - `integration:write`    → Set / Rotate / Clear affordances.
// WRITE-ONLY: the key value is never fetched or displayed — only the has-key
// boolean. Entering a new value and saving rotates it.

interface Props {
  readonly sessionOverride?: Session;
  readonly loadFn?: () => Promise<TenantLlmKeyStatus>;
  readonly setFn?: (apiKey: string) => Promise<TenantLlmKeyStatus>;
  readonly clearFn?: () => Promise<TenantLlmKeyStatus>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; configured: boolean }
  | { status: 'error'; message: string };

export function AnthropicLlmKeyPanel({ sessionOverride, loadFn, setFn, clearFn }: Props) {
  const sessionState = useSession();
  const session =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const toast = useToast();
  const load = loadFn ?? defaultLoad;
  const doSet = setFn ?? defaultSet;
  const doClear = clearFn ?? defaultClear;

  const canRead = session !== null && hasScope(session, 'integration:read');
  const canWrite = session !== null && hasScope(session, 'integration:write');

  const [state, setState] = useState<State>({ status: 'loading' });
  const [draftKey, setDraftKey] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    load()
      .then((s) => setState({ status: 'ready', configured: s.configured }))
      .catch((e) => setState({ status: 'error', message: safeErrorMessage(e, 'Failed to load status.') }));
  }, [load]);

  useEffect(() => {
    if (!canRead) return;
    refresh();
  }, [canRead, refresh]);

  // Least-visibility: absent read scope → render nothing AND make no fetch.
  if (!canRead) return null;

  const onSave = async () => {
    if (draftKey.length === 0) return;
    setBusy(true);
    try {
      const s = await doSet(draftKey);
      setDraftKey(''); // never retain the value in the UI
      setState({ status: 'ready', configured: s.configured });
      toast.show('Anthropic key saved.');
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to save key.'));
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    setBusy(true);
    try {
      const s = await doClear();
      setState({ status: 'ready', configured: s.configured });
      toast.show('Anthropic key cleared.');
    } catch (e) {
      toast.show(safeErrorMessage(e, 'Failed to clear key.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SettingCardHead
        title="Anthropic"
        sub="AI / LLM · Your tenant's own Anthropic API key powers governed résumé extraction and other AI features. The key is stored securely and never displayed after saving. Aramo does not fall back to a shared key."
      />
      {state.status === 'loading' && <LoadingState label="Loading status…" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={refresh} />}
      {state.status === 'ready' && (
        <div className="rc-stack">
          <p className="rc-muted-line" data-testid="anthropic-key-status">
            Status: {state.configured ? 'Configured' : 'Not configured'}
          </p>
          {canWrite && (
            <>
              <label className="rc-field">
                <span className="rc-field-label">API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  className="rc-input"
                  placeholder={state.configured ? 'Enter a new key to rotate' : 'sk-ant-…'}
                  value={draftKey}
                  onChange={(e) => setDraftKey(e.target.value)}
                  data-testid="anthropic-key-input"
                />
              </label>
              <div className="rc-row">
                <Button onClick={onSave} disabled={busy || draftKey.length === 0} data-testid="anthropic-key-save">
                  {state.configured ? 'Rotate key' : 'Set key'}
                </Button>
                {state.configured && (
                  <Button variant="secondary" onClick={onClear} disabled={busy} data-testid="anthropic-key-clear">
                    Clear
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
