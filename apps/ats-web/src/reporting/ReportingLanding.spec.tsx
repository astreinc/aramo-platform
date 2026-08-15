import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ReportingLanding } from './ReportingLanding';

// T9-B2 (§20) — the Reports IA index. Proves the single Reports area reaches BOTH
// Fallthrough (new) and Fill Performance (B1, still reachable) from one landing —
// no second ambiguous top-level rail entry is introduced.
describe('ReportingLanding', () => {
  it('links to both Fill Performance and Fallthrough', () => {
    render(
      <MemoryRouter>
        <ReportingLanding />
      </MemoryRouter>,
    );
    const fill = screen.getByTestId('reports-link-fill-performance');
    const fallthrough = screen.getByTestId('reports-link-fallthrough');
    const assignmentPipeline = screen.getByTestId('reports-link-assignment-pipeline');
    expect(fill).toHaveAttribute('href', '/reports/fill-performance');
    expect(fallthrough).toHaveAttribute('href', '/reports/fallthrough');
    expect(assignmentPipeline).toHaveAttribute(
      'href',
      '/reports/assignment-pipeline',
    );
  });
});
