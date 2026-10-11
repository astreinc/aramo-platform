import { useCallback, useEffect, useState } from 'react';
import { Button } from '@aramo/fe-foundation';

import {
  getMicrosoftBindingStatus as defaultLoadStatus,
  startMicrosoftAuthorize as defaultStartAuthorize,
  type MicrosoftBindingStatus,
} from './microsoft-api';

// My Settings → Connected accounts: the SIGNED-IN user's OWN Microsoft 365
// mailbox connection (delegated OAuth / PKCE). Context-free — no talent/req — so
// it belongs in personal settings, distinct from (a) the tenant-level provider
// establishment (admin, Settings → Integrations) and (b) the talent-scoped
// send-email / create-meeting actions (Talent panel). No token ever crosses the
// surface; the "Connect" action redirects the browser to the Microsoft consent
// screen and returns via the server-side callback that binds the identity.

export interface MicrosoftAccountConnectionProps {
  readonly loadStatusFn?: () => Promise<MicrosoftBindingStatus>;
  // A1 R4 — optional capability: omitted = baseline connect (unchanged); 'scheduling'
  // starts the incremental Calendars.ReadWrite consent for Outlook scheduling.
  readonly startAuthorizeFn?: (capability?: 'scheduling') => Promise<{ authorize_url: string }>;
  /** Redirect to the Microsoft authorize URL. Injectable for tests. */
  readonly onNavigate?: (url: string) => void;
}

export function MicrosoftAccountConnection(
  props: MicrosoftAccountConnectionProps,
): JSX.Element {
  const load = props.loadStatusFn ?? defaultLoadStatus;
  const startAuthorize = props.startAuthorizeFn ?? defaultStartAuthorize;
  const navigate =
    props.onNavigate ??
    ((url: string) => {
      window.location.assign(url);
    });

  const [status, setStatus] = useState<MicrosoftBindingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    load()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, [load]);

  const onConnect = useCallback(() => {
    setBusy(true);
    setError(null);
    startAuthorize()
      .then(({ authorize_url }) => navigate(authorize_url))
      .catch(() => {
        setError('We couldn’t start the Microsoft connection. Please try again.');
        setBusy(false);
      });
  }, [startAuthorize, navigate]);

  // A1 R4 — opt-in: start the incremental Calendars.ReadWrite consent for the already-
  // connected account. Does NOT disconnect the existing connection; Microsoft adds the
  // calendar scope on top of the baseline grant and the server-side callback re-binds.
  const onEnableScheduling = useCallback(() => {
    setBusy(true);
    setError(null);
    startAuthorize('scheduling')
      .then(({ authorize_url }) => navigate(authorize_url))
      .catch(() => {
        setError('We couldn’t start Outlook scheduling authorization. Please try again.');
        setBusy(false);
      });
  }, [startAuthorize, navigate]);

  const connected = status !== null && status.bound && !status.needs_reauthorization;
  const reconnect = status !== null && status.bound && status.needs_reauthorization;
  const label =
    status === null ? 'Checking…' : connected ? 'Connected' : reconnect ? 'Reconnect needed' : 'Not connected';

  return (
    <div className="my-conn" data-testid="microsoft-account-connection">
      <span className="my-conn__main">
        <span className="my-conn__name">Microsoft 365</span>
        <span className="my-conn__desc">
          Send email and create Teams meetings as you. This connects your own
          mailbox — separate from the tenant-level provider your admin configures
          under Settings → Integrations.
        </span>
      </span>
      <span
        data-testid="microsoft-account-status"
        className={`my-conn__chip my-conn__chip--${connected ? 'ok' : 'muted'}`}
      >
        {label}
      </span>
      {status !== null && !connected ? (
        <Button unstyled
          type="button"
          className="rc-hbtn rc-hbtn--primary"
          data-testid="microsoft-account-connect"
          disabled={busy}
          onClick={onConnect}
        >
          {reconnect ? 'Reconnect' : 'Connect account'}
        </Button>
      ) : null}
      {/* A1 R4 — opt-in Outlook scheduling consent, offered only on a connected account.
          The grant is NOT inferred from a redirect; the recruiter completes Microsoft
          consent and the server-side callback binds the elevated token. */}
      {connected ? (
        <Button unstyled
          type="button"
          className="rc-hbtn"
          data-testid="microsoft-enable-scheduling"
          disabled={busy}
          onClick={onEnableScheduling}
        >
          Enable Outlook scheduling
        </Button>
      ) : null}
      {error !== null ? (
        <p className="rc-warnnote" role="status" data-testid="microsoft-account-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
