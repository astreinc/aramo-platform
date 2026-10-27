import { ssoEntryHref } from '@aramo/fe-foundation';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DocumentTemplatesRedirect, documentTemplatesRedirectHref } from './DocumentTemplatesRedirect';

// TEMPLATE-STUDIO-1 S-4 (§1.8 / §5) — ATS Settings has no Document templates page; every
// old ATS link redirects to App Home /org/document-templates through the org SSO entry,
// returning to the ATS settings landing (never back to the redirecting URL).
const RETURN = '/ats/admin/settings/recruiting';
const EXPECTED = ssoEntryHref(`/org/document-templates?from=ats&return=${encodeURIComponent(RETURN)}`, 'org');

describe('DocumentTemplatesRedirect', () => {
  it('redirects the old section URL to the App Home entry with an ATS return context', () => {
    window.history.pushState({}, '', '/ats/admin/settings/document-templates');
    const replace = vi.fn();
    render(<DocumentTemplatesRedirect replace={replace} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(EXPECTED);
    expect(EXPECTED).toMatch(/^\/auth\/org\/login\?/);
    // A plain fallback link to the same target, and no template administration.
    expect(screen.getByTestId('doc-templates-org-home-link')).toHaveAttribute('href', EXPECTED);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('redirects retired deep links (RTR detail / draft) to the same entry', () => {
    for (const p of [
      '/ats/admin/settings/document-templates/rtr',
      '/ats/admin/settings/document-templates/3f1c/draft',
    ]) {
      expect(documentTemplatesRedirectHref(p)).toBe(EXPECTED);
    }
  });
});
