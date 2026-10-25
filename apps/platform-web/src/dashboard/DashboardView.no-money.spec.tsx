import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type PlatformDashboard } from '../platform-api';
import { ALL_TENANT_SCOPES, renderAt, tenantSession } from '../tenants/test-utils';

import { DashboardView } from './DashboardView';

// CCP-C6 (PBD §5.2 row C6 "Out: dashboard money"; PLATFORM-UX-1 Amendment A1-4a / ruling A0-C6) —
// the operator dashboard shows counts, states and operational events only. Monetary figures exist
// only on the dedicated Finance routes (GET /platform/commercial/finance/*), and no console source
// outside a Finance screen reads them.

const DATA: PlatformDashboard = {
  status_counts: [
    { status: 'PROVISIONED', count: 3 },
    { status: 'ACTIVE', count: 5 },
    { status: 'SUSPENDED', count: 1 },
    { status: 'OFFBOARDING', count: 0 },
    { status: 'CLOSED', count: 2 },
  ],
  onboarding: [{ tenant_id: 't-1', name: 'Acme Co', created_at: '2026-10-01T00:00:00.000Z', invited: true }],
  recent_activity: [
    { event_type: 'tenant.suspended', tenant_id: 't-1', tenant_name: 'Acme Co', actor_type: 'user', reason_code: 'payment_overdue', created_at: '2026-10-20T00:00:00.000Z' },
  ],
};

const MONEY = /\$\s?\d|USD|EUR|GBP|\bMRR\b|\bARR\b|revenue|amount_minor|list_price|price/i;

// The vitest root is the app (nx) or the repo root; resolve the app's src from either.
const SRC = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'apps/platform-web/src')].find((d) => existsSync(join(d, 'dashboard/DashboardView.tsx'))) ?? '';
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('CCP-C6 — the dashboard renders no money (A0-C6)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('C6-DASH-1 the rendered dashboard carries counts, states and events, and no monetary figure', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(DATA);
    const { container } = renderAt(<DashboardView session={tenantSession(ALL_TENANT_SCOPES)} />, { path: '/', url: '/', session: tenantSession(ALL_TENANT_SCOPES) });
    expect((await screen.findAllByRole('link', { name: 'Acme Co' })).length).toBeGreaterThan(0);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Active/);
    expect(text).not.toMatch(MONEY);
  });

  it('C6-DASH-2 the dashboard contract has no monetary field', () => {
    const keys = JSON.stringify(DATA);
    expect(keys).not.toMatch(/amount|price|currency|revenue|mrr|arr\b/i);
    const view = readFileSync(join(SRC, 'dashboard/DashboardView.tsx'), 'utf8');
    expect(view).not.toMatch(/amount_minor|list_price|currency|\/finance\//);
  });

  it('C6-DASH-3 no console source outside a Finance screen calls the Finance routes', () => {
    const callers = sources(SRC).filter((f) => readFileSync(f, 'utf8').includes('/platform/commercial/finance'));
    expect(callers.filter((f) => !/[\\/]finance[\\/]/.test(f))).toEqual([]);
  });
});

// CCP-D2 (PBD §5.4 row D2 "Out: monetary metrics on the dashboard"; HALT "any monetary metric on the
// dashboard") — revenue (MRR, ARR, the renewal pipeline) is built behind GET
// /platform/commercial/finance/revenue only, with every amount withheld. No Finance revenue screen
// exists yet (it needs design release CCP-UI v1.1), so no console source reads it, and the dashboard
// contract and view carry no revenue metric.
describe('CCP-D2 — no revenue metric reaches the dashboard', () => {
  it('D2-DASH-1 no console source calls the revenue route (no Finance revenue screen is built)', () => {
    expect(sources(SRC).filter((f) => readFileSync(f, 'utf8').includes('/finance/revenue'))).toEqual([]);
  });

  it('D2-DASH-2 the dashboard view, its contract and its API call carry no revenue metric', () => {
    const view = readFileSync(join(SRC, 'dashboard/DashboardView.tsx'), 'utf8');
    expect(view).not.toMatch(/\bmrr\b|\barr\b|revenue|renewal_pipeline|amount_withheld|FINANCE_SCOPE_PENDING|_minor\b/i);
    const api = readFileSync(join(SRC, 'platform-api.ts'), 'utf8');
    const contract = api.slice(api.indexOf('export interface PlatformDashboardStatusCount'), api.indexOf('export interface ProvisionTenantResult'));
    expect(contract.length).toBeGreaterThan(0);
    expect(contract).not.toMatch(/amount|price|currency|revenue|mrr|\barr\b|_minor/i);
    const call = api.slice(api.indexOf('getDashboard('), api.indexOf('getDashboard(') + 200);
    expect(call).not.toMatch(/finance|revenue/);
  });
});
