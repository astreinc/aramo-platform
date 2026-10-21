import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DocumentTemplatesMovedSection } from './DocumentTemplatesMovedSection';

// DOC-TEMPLATE-LIB-1 T-4 (§8.4) — the ATS Settings document-templates section is retired.
// What remains is one link into Org Home (through the org sign-in route, carrying this
// page as the return context); no editor, no template list, no template action.
describe('DocumentTemplatesMovedSection', () => {
  it('links to Org Home document templates through the org SSO entry with an ATS return context', () => {
    window.history.pushState({}, '', '/ats/admin/settings/document-templates');
    render(<DocumentTemplatesMovedSection />);
    const link = screen.getByTestId('doc-templates-org-home-link');
    expect(link).toHaveTextContent('Manage templates in Org Home');
    const href = link.getAttribute('href') ?? '';
    expect(href).toMatch(/^\/auth\/org\/login\?/);
    const returnTo = decodeURIComponent(new URL(href, 'https://t.aramo.ai').searchParams.get('return_to') ?? href);
    expect(returnTo).toContain('/org/document-templates');
    expect(returnTo).toContain('from=ats');
  });

  it('renders no template administration (no editor, no list, no buttons)', () => {
    render(<DocumentTemplatesMovedSection />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('doc-templates-page')).toBeNull();
    expect(screen.getByTestId('doc-templates-moved')).toHaveTextContent('Org Home');
  });
});
