import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReportsOverview, SenderContext } from '../api';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED) §1.13 — the organization reports
// page shows ONLY while the backend reports sign.reports available AND the session holds
// sign:report:read; otherwise the existing Reports page is shown unchanged (dark by default).

const overview = vi.fn();
const download = vi.fn();
const summary = vi.fn();
const list = vi.fn();
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    reportsApi: { ...mod.reportsApi, overview: (...a: unknown[]) => overview(...a) },
    downloadCsv: (...a: unknown[]) => download(...a),
    senderApi: { ...mod.senderApi, summary: (...a: unknown[]) => summary(...a), list: (...a: unknown[]) => list(...a) },
  };
});
let ctx: Partial<SenderContext> = {};
vi.mock('../workspace', () => ({ useWorkspace: () => ({ base: '/sign', ctx }) }));

import { ReportsRoute, presetRange } from './Reports';

const STATS = { sent: 0, completed: 0, declined: 0, voided: 0, expired: 0, in_flight: 0, completion_rate: null, turnaround_average_hours: null, turnaround_median_hours: null, turnaround_p90_hours: null };
const OVERVIEW: ReportsOverview = {
  range: { from: '2026-08-04', to: '2026-11-01', period: 'week', timezone: 'UTC' },
  totals: { ...STATS, sent: 8, completed: 6, in_flight: 1, declined: 1, completion_rate: 75, turnaround_average_hours: 30, turnaround_median_hours: 20.5, turnaround_p90_hours: 70 },
  volume: [
    { period_start: '2026-10-19', sent: 3, completed: 2, declined: 0, voided: 0 },
    { period_start: '2026-10-26', sent: 5, completed: 4, declined: 1, voided: 0 },
  ],
  by_sender: [{ ...STATS, sender_id: 'u1', sender_name: 'Priya Nair', sent: 8, completed: 6, completion_rate: 75, turnaround_median_hours: 20.5 }],
  by_template: [
    { ...STATS, template_ref: null, template_name: null, sent: 5 },
    { ...STATS, template_ref: 'abcdef12-0000-7000-8000-000000000000', template_name: null, sent: 3 },
  ],
};

const show = () =>
  render(
    <MemoryRouter>
      <ReportsRoute />
    </MemoryRouter>,
  );

beforeEach(() => {
  overview.mockResolvedValue(OVERVIEW);
  download.mockResolvedValue(undefined);
  summary.mockReturnValue(new Promise(() => undefined));
  list.mockReturnValue(new Promise(() => undefined));
});
afterEach(() => vi.clearAllMocks());

describe('Reports route', () => {
  it('while sign.reports is not available the organization reports stay hidden (existing page, no reports call)', () => {
    ctx = { features: { templates: false }, permissions: { read: true, create: true, send: true, reports: true } };
    show();
    expect(screen.queryByTestId('org-reports')).not.toBeInTheDocument();
    expect(overview).not.toHaveBeenCalled();
    expect(summary).toHaveBeenCalled();
  });

  it('a session without sign:report:read keeps the existing page even when the capability is available', () => {
    ctx = { features: { reports: true }, permissions: { read: true, create: true, send: true, reports: false } };
    show();
    expect(screen.queryByTestId('org-reports')).not.toBeInTheDocument();
    expect(overview).not.toHaveBeenCalled();
  });

  it('shows totals, turnaround, senders and templates, and exports CSVs', async () => {
    ctx = { features: { reports: true }, permissions: { read: true, create: false, send: false, reports: true } };
    show();
    expect(await screen.findAllByText('75%')).toHaveLength(2);
    expect(screen.getAllByText('20.5h')).toHaveLength(2);
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('Not from a template')).toBeInTheDocument();
    expect(screen.getByText('Template abcdef12')).toBeInTheDocument();
    expect(overview).toHaveBeenCalledWith(expect.objectContaining({ period: 'week' }));

    fireEvent.click(screen.getByTestId('export-audit'));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.stringMatching(/^\/v1\/sign\/sender\/reports\/envelopes\/export\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/), 'aramo-sign-envelope-audit.csv'));
    fireEvent.click(screen.getByTestId('export-summary'));
    await waitFor(() => expect(download).toHaveBeenLastCalledWith(expect.stringContaining('/v1/sign/sender/reports/export?'), 'aramo-sign-summary.csv'));
    expect(String(download.mock.calls[1]?.[0])).toContain('report=summary');
  });

  it('shows the backend refusal instead of figures', async () => {
    ctx = { features: { reports: true }, permissions: { read: true, create: true, send: true, reports: true } };
    overview.mockRejectedValue(new ApiError(403, 'Reports are part of the Business plans', 'ESIGN_FEATURE_NOT_AVAILABLE', { feature_key: 'sign.reports', reason: 'business_plans_only' }));
    show();
    expect(await screen.findByText('Reports aren’t available on your Aramo Sign plan yet.')).toBeInTheDocument();
  });

  it('preset ranges end today (UTC) and are inclusive', () => {
    expect(presetRange('30', new Date('2026-11-01T23:00:00Z'))).toEqual({ from: '2026-10-03', to: '2026-11-01' });
  });
});
