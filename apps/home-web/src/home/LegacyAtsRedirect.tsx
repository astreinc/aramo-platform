import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// D-ORG-2 — bookmark compatibility for the T1 topology. Before D-ORG the ATS app
// owned the tenant host root, so saved links look like /talent/<id> or
// /requisitions/<id>?tab=… . Those paths now belong to the ATS SPA at /ats/, so
// the App Home forwards them there (a full navigation — it is a different SPA)
// with the query string and fragment preserved. Pure prefixing: no path is
// interpreted here; the ATS app owns its own 404/authorization outcomes.
export const ATS_APP_BASE = '/ats';

export function legacyAtsHref(location: { pathname: string; search: string; hash: string }): string {
  const path = location.pathname.startsWith('/') ? location.pathname : `/${location.pathname}`;
  return `${ATS_APP_BASE}${path}${location.search}${location.hash}`;
}

interface LegacyAtsRedirectProps {
  /** Test seam — replaces the full-page navigation. */
  readonly onRedirect?: (href: string) => void;
}

export function LegacyAtsRedirect({ onRedirect }: LegacyAtsRedirectProps = {}) {
  const location = useLocation();
  const href = legacyAtsHref(location);
  useEffect(() => {
    (onRedirect ?? ((h: string) => window.location.replace(h)))(href);
  }, [href, onRedirect]);
  return (
    <section className="home-forward" role="status" aria-live="polite">
      <p>Opening this page in the Aramo ATS…</p>
      <a href={href}>Continue to the ATS</a>
    </section>
  );
}
