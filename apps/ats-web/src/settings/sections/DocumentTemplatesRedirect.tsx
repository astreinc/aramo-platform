import { useEffect } from 'react';
import { orgEntryHref } from '@aramo/fe-foundation';

// TEMPLATE-STUDIO-1 S-4 (Implementation Directive v1.0 LOCKED §1.8 / §5; Conforming
// Amendment #5) — ATS Settings has no Document templates page. Template administration
// lives in App Home (/org/document-templates), reached from the Organization · shared rail
// entry. Any old ATS link (`/admin/settings/document-templates/*`, incl. the retired RTR
// detail / draft deep links) redirects there through the org consumer's sign-in route, so
// the SSO session carries over.
//
// Return context: the ATS settings landing (Recruiting settings), not the old URL — the old
// URL would only redirect straight back to App Home.
const ORG_SECTION = 'document-templates';
const OLD_SUFFIX = /\/admin\/settings\/document-templates(?:\/.*)?$/;
const RETURN_SUFFIX = '/admin/settings/recruiting';

/** The App Home entry an old ATS document-templates URL redirects to. */
export function documentTemplatesRedirectHref(pathname: string): string {
  const back = OLD_SUFFIX.test(pathname) ? pathname.replace(OLD_SUFFIX, RETURN_SUFFIX) : pathname;
  return orgEntryHref(ORG_SECTION, { app: 'ats', path: back });
}

function pageReplace(href: string): void {
  window.location.replace(href);
}

export function DocumentTemplatesRedirect({
  replace = pageReplace,
}: {
  /** Test seam; defaults to a full-page replace (the target is another SPA on this host). */
  readonly replace?: (href: string) => void;
} = {}) {
  const href = documentTemplatesRedirectHref(typeof window === 'undefined' ? '' : window.location.pathname);
  useEffect(() => {
    replace(href);
  }, [href, replace]);
  return (
    <p className="set-muted" role="status" data-testid="doc-templates-redirect">
      Opening Document templates in App Home…{' '}
      <a href={href} data-testid="doc-templates-org-home-link">
        Continue
      </a>
    </p>
  );
}
