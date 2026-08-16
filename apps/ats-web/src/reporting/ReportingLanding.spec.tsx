import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { ReportingLanding } from './ReportingLanding';

// T9-B2 (§20) — the Reports IA index. Proves the single Reports area reaches
// Fill Performance (B1), Fallthrough (B2), and Assignment Pipeline (B3) from one
// landing — no second ambiguous top-level rail entry.
// T9-B4 (§14) — the Margin link is the fourth entry, shown ONLY with
// assignment:commercials:read.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

describe('ReportingLanding', () => {
  it('links to Fill Performance, Fallthrough, and Assignment Pipeline', () => {
    render(
      <MemoryRouter>
        <ReportingLanding sessionOverride={makeSession(['report:read'])} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('reports-link-fill-performance')).toHaveAttribute(
      'href',
      '/reports/fill-performance',
    );
    expect(screen.getByTestId('reports-link-fallthrough')).toHaveAttribute(
      'href',
      '/reports/fallthrough',
    );
    expect(screen.getByTestId('reports-link-assignment-pipeline')).toHaveAttribute(
      'href',
      '/reports/assignment-pipeline',
    );
  });

  it('shows the Margin link ONLY with assignment:commercials:read', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ReportingLanding sessionOverride={makeSession(['report:read'])} />
      </MemoryRouter>,
    );
    // Without the commercial scope → no Margin link.
    expect(screen.queryByTestId('reports-link-margin')).toBeNull();

    rerender(
      <MemoryRouter>
        <ReportingLanding
          sessionOverride={makeSession(['report:read', 'assignment:commercials:read'])}
        />
      </MemoryRouter>,
    );
    // With it → the fourth link is present and points at /reports/margin.
    expect(screen.getByTestId('reports-link-margin')).toHaveAttribute(
      'href',
      '/reports/margin',
    );
  });
});
