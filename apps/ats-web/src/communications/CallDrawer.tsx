import { useEffect, useState } from 'react';
import { ApiError } from '@aramo/fe-foundation';

import type { TalentRecordView } from '../talent/types';

import { getMyCommunicationProviderIdentity } from './communications-api';
import { ZoomPhoneEmbed, type ZoomEmbedLoader } from './ZoomPhoneEmbed';
import type { CommunicationProviderIdentity } from './types';

// COMM-B4 — the recruiter Call drawer. Ships the UX shell (phone picker,
// "calling as", "regarding", provider embed) but DOES NOT initiate a call: the
// submit stays disabled until COMM-B5 introduces POST /v1/communications/calls +
// the server-side contacting-consent gate. No Zoom vocabulary lives here — it is
// confined to ZoomPhoneEmbed. Phone suppression is backend-authoritative: a
// suppressed/absent number arrives null and simply never appears in the picker.

interface PhoneOption {
  readonly key: 'cell' | 'work' | 'home';
  readonly label: string;
  readonly number: string;
}

function phoneOptions(t: TalentRecordView): PhoneOption[] {
  return [
    { key: 'cell' as const, label: 'Mobile', number: t.phone_cell },
    { key: 'work' as const, label: 'Work', number: t.phone_work },
    { key: 'home' as const, label: 'Home', number: t.phone_home },
  ].filter((o): o is PhoneOption => o.number !== null && o.number.length > 0);
}

type IdentityState =
  | { kind: 'loading' }
  | { kind: 'ready'; identity: CommunicationProviderIdentity }
  | { kind: 'not_mapped' }
  | { kind: 'error' };

export interface CallDrawerProps {
  readonly talent: TalentRecordView;
  readonly onClose: () => void;
  /** Injected for tests; defaults to the real client. */
  readonly providerIdentityFn?: () => Promise<CommunicationProviderIdentity>;
  readonly embedLoader?: ZoomEmbedLoader;
}

export function CallDrawer({
  talent,
  onClose,
  providerIdentityFn = getMyCommunicationProviderIdentity,
  embedLoader,
}: CallDrawerProps) {
  const options = phoneOptions(talent);
  const [selected, setSelected] = useState<PhoneOption['key'] | null>(options[0]?.key ?? null);
  const [identity, setIdentity] = useState<IdentityState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    providerIdentityFn()
      .then((id) => {
        if (!cancelled) setIdentity({ kind: 'ready', identity: id });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setIdentity({ kind: 'not_mapped' });
        } else {
          setIdentity({ kind: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [providerIdentityFn]);

  const callerReady = identity.kind === 'ready';

  return (
    <aside className="rc-comm-drawer" role="dialog" aria-label={`Call ${talent.first_name} ${talent.last_name}`}>
      <header className="rc-comm-drawer__hd">
        <h2 className="rc-comm-drawer__title">Call {talent.first_name} {talent.last_name}</h2>
        <button type="button" className="rc-comm-drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <fieldset className="rc-comm-drawer__section">
        <legend>Number</legend>
        {options.length === 0 ? (
          <p className="rc-comm-drawer__empty">No phone number on file for this talent.</p>
        ) : (
          options.map((o) => (
            <label key={o.key} className="rc-comm-drawer__radio">
              <input
                type="radio"
                name="rc-comm-phone"
                value={o.key}
                checked={selected === o.key}
                onChange={() => setSelected(o.key)}
              />
              {o.label} · {o.number}
            </label>
          ))
        )}
      </fieldset>

      <section className="rc-comm-drawer__section">
        <h3 className="rc-comm-drawer__subhd">Calling as</h3>
        {identity.kind === 'loading' ? (
          <p className="rc-comm-drawer__muted">Loading…</p>
        ) : identity.kind === 'ready' ? (
          <p className="rc-comm-drawer__caller">
            {identity.identity.display_phone_number ??
              identity.identity.extension ??
              identity.identity.provider_user_id}
          </p>
        ) : identity.kind === 'not_mapped' ? (
          <p className="rc-comm-drawer__muted">
            Calling is unavailable because your account isn’t mapped to a phone provider yet.
            Ask a tenant administrator to set up your mapping.
          </p>
        ) : (
          <p className="rc-comm-drawer__muted">Couldn’t load your calling identity.</p>
        )}
      </section>

      <section className="rc-comm-drawer__section">
        <h3 className="rc-comm-drawer__subhd">Regarding</h3>
        <p className="rc-comm-drawer__muted">General talent contact</p>
      </section>

      <ZoomPhoneEmbed loader={embedLoader} />

      <footer className="rc-comm-drawer__ft">
        <button
          type="button"
          className="rc-comm-drawer__call"
          disabled
          title="Call initiation arrives in a later release"
        >
          Call
        </button>
        <p className="rc-comm-drawer__note">
          {callerReady && selected !== null
            ? 'Call initiation arrives in a later release.'
            : 'Select a number and confirm your calling identity to place a call.'}
        </p>
      </footer>
    </aside>
  );
}
