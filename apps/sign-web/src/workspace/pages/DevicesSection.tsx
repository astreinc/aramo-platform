import { ApiError, apiClient, getAuthConsumer } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from '../api';
import { Btn, ErrorBox, Loading, fmtDate } from '../ui';

// Amendment M-A18 (LOCKED) — Settings → Devices: the phones signed in to this account (this
// workspace), each with Sign out. The same list and sign-out the app offers under
// Account → Devices, through GET / DELETE /auth/me/devices (the browser session; the
// shared client sends the X-Aramo-Consumer header the DELETE requires). D-1 (a): the phone
// is signed out within 15 minutes, when its current access token runs out.

export interface PhoneSession {
  device_session_id: string;
  platform: string;
  app_version: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export const devicesApi = {
  list: () => apiClient.get<{ items: PhoneSession[] }>(`/auth/me/devices?consumer=${getAuthConsumer()}`).then((r) => r.items ?? []),
  signOut: (id: string) => apiClient.delete<void>(`/auth/me/devices/${encodeURIComponent(id)}?consumer=${getAuthConsumer()}`),
};

export function phoneLabel(s: Pick<PhoneSession, 'platform' | 'app_version'>): string {
  const p = s.platform === 'ios' ? 'iPhone' : s.platform === 'android' ? 'Android phone' : 'Phone';
  return s.app_version ? `${p} · Aramo Sign ${s.app_version}` : p;
}

export const DEVICES_COPY = {
  intro: 'Phones signed in to Aramo Sign with this account. Sign out a phone you no longer use, or one that was lost.',
  empty: 'No phones are signed in to Aramo Sign.',
  confirm: 'Sign out this phone? It will need to sign in again.',
  done: 'Signed out. The phone will be signed out within 15 minutes.',
} as const;

export function DevicesSection({ api = devicesApi }: { api?: typeof devicesApi } = {}) {
  const [items, setItems] = useState<PhoneSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.list().then(
      (list) =>
        setItems(
          [...list].sort((a, b) => String(b.last_seen_at ?? b.created_at).localeCompare(String(a.last_seen_at ?? a.created_at))),
        ),
      (e: unknown) => setError(errorMessage(e, 'Your devices couldn’t be loaded. Try again.')),
    );
  }, [api]);
  useEffect(load, [load]);

  const signOut = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.signOut(id);
      setNotice(DEVICES_COPY.done);
    } catch (e) {
      // Already signed out elsewhere: the same outcome, the row just leaves the list.
      if (!(e instanceof ApiError && e.status === 404)) {
        setError(errorMessage(e, 'The phone couldn’t be signed out. Try again.'));
        setBusy(false);
        return;
      }
    }
    setItems((xs) => (xs ?? []).filter((x) => x.device_session_id !== id));
    setConfirming(null);
    setBusy(false);
  };

  return (
    <section className="sg-card" data-testid="settings-devices">
      <div className="sg-card__head">Devices</div>
      <div className="sg-card__body">
        <p className="sg-muted" style={{ marginTop: 0 }}>
          {DEVICES_COPY.intro}
        </p>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        {notice !== null ? (
          <p role="status" className="sg-help" data-testid="devices-notice">
            {notice}
          </p>
        ) : null}
        {items === null && error === null ? <Loading /> : null}
        {items !== null && items.length === 0 ? <p data-testid="devices-empty">{DEVICES_COPY.empty}</p> : null}
        {items !== null && items.length > 0 ? (
          <ul className="sg-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((s) => (
              <li key={s.device_session_id} data-testid="device-row" style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{phoneLabel(s)}</strong>
                    <div className="sg-muted">
                      Signed in {fmtDate(s.created_at)}
                      {s.last_seen_at ? ` · last used ${fmtDate(s.last_seen_at, true)}` : ''}
                    </div>
                  </div>
                  {confirming === s.device_session_id ? null : (
                    <Btn size="sm" onClick={() => setConfirming(s.device_session_id)} disabled={busy} aria-label={`Sign out ${phoneLabel(s)}`}>
                      Sign out
                    </Btn>
                  )}
                </div>
                {confirming === s.device_session_id ? (
                  <div role="alertdialog" aria-label="Sign out this phone" style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>{DEVICES_COPY.confirm}</span>
                    <Btn size="sm" variant="danger" disabled={busy} onClick={() => void signOut(s.device_session_id)} data-testid="device-signout-confirm">
                      Sign out
                    </Btn>
                    <Btn size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                      Cancel
                    </Btn>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
