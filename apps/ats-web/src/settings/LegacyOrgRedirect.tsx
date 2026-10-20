import { useEffect } from 'react';
import { orgEntryHref } from '@aramo/fe-foundation';

// Accepted Settings & navigation change log A2 — ATS pages that moved to
// Organization administration redirect ONCE, automatically, to the
// organization page (a full navigation: it is the App Home SPA on this host).
// The return context points back to the ATS Settings home (the old page no
// longer exists in the ATS). Old bookmarks keep working; no loop is possible
// because /org/* never redirects back into /ats/.
const ATS_SETTINGS_HOME = '/ats/admin/settings/recruiting';

interface Props {
  readonly section: 'profile' | 'users' | 'domain';
  /** Test seam — replaces the full-page navigation. */
  readonly onRedirect?: (href: string) => void;
}

export function LegacyOrgRedirect({ section, onRedirect }: Props) {
  const href = orgEntryHref(section, { app: 'ats', path: ATS_SETTINGS_HOME });
  useEffect(() => {
    (onRedirect ?? ((h: string) => window.location.replace(h)))(href);
  }, [href, onRedirect]);
  return (
    <p className="set-muted" role="status">
      This page moved to Organization administration. <a href={href}>Continue</a>
    </p>
  );
}
