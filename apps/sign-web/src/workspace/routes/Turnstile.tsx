import { useEffect, useRef } from 'react';

// Aramo Sign Personal §6.1 — the Cloudflare Turnstile robot check, verified
// server-side on `start`. The script is fetched from challenges.cloudflare.com
// ONLY when a site key is configured (the sign host CSP must then allow
// https://challenges.cloudflare.com in script-src and frame-src). Without a key
// this renders nothing and the form sends robot_token: null.

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove?: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'sg-turnstile';

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  if (loading !== null) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile !== undefined ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({ siteKey, onToken }: { siteKey: string | null; onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (siteKey === null || ref.current === null) return undefined;
    let live = true;
    let widget: string | null = null;
    const el = ref.current;
    loadTurnstile()
      .then((t) => {
        if (!live) return;
        widget = t.render(el, {
          sitekey: siteKey,
          action: 'personal_signup',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      live = false;
      if (widget !== null) window.turnstile?.remove?.(widget);
    };
  }, [siteKey]);

  if (siteKey === null) return null;
  return <div ref={ref} className="sg-turnstile" data-testid="turnstile" aria-label="Security check" role="group" />;
}
