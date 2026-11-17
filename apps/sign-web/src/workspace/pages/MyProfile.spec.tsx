import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { MyProfileSection } from './MyProfile';

// UAT PRF-01 — Settings → My profile, the same /v1/sign/me/profile record as the app.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@example.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Acme', kind: 'BUSINESS' },
  workspace: 'sign',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  organization_url: null,
  app_home_url: null,
};
const EMPTY = { display_name: 'Pat Lee', title: null, company: null, address_line1: null, address_line2: null, city: null, region: null, postal_code: null, country: null, phone: null, email: 'pat@example.com', updated_at: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; url: string; body: unknown };
function stub(calls: Call[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/v1/sign/me/profile') && method === 'GET') return json(EMPTY);
      if (url.endsWith('/v1/sign/me/profile') && method === 'PUT') return json({ ...EMPTY, ...(body as object), updated_at: '2026-11-17T10:00:00Z' });
      return json({});
    }),
  );
}

function show() {
  render(
    <MemoryRouter>
      <WorkspaceProvider ctx={CTX}>
        <MyProfileSection />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('Settings — My profile (UAT PRF-01)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('saves the profile as the app does (trimmed; empty optional fields null; country upper-cased)', async () => {
    const calls: Call[] = [];
    stub(calls);
    show();
    fireEvent.change(await screen.findByTestId('profile-name'), { target: { value: ' Pat Q. Lee ' } });
    fireEvent.change(screen.getByTestId('profile-title'), { target: { value: 'Director' } });
    fireEvent.change(screen.getByTestId('profile-company'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByTestId('profile-phone'), { target: { value: '+15551234567' } });
    fireEvent.change(screen.getByTestId('profile-address_line1'), { target: { value: '1 Main St' } });
    fireEvent.change(screen.getByTestId('profile-country'), { target: { value: 'us' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      display_name: 'Pat Q. Lee', title: 'Director', company: 'Acme', address_line1: '1 Main St', address_line2: null,
      city: null, region: null, postal_code: null, country: 'US', phone: '+15551234567',
    });
  });

  it('checks the phone and country like the app, before saving', async () => {
    const calls: Call[] = [];
    stub(calls);
    show();
    fireEvent.change(await screen.findByTestId('profile-phone'), { target: { value: '555' } });
    fireEvent.change(screen.getByTestId('profile-country'), { target: { value: 'USA' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    expect(await screen.findByText('Use the international format, e.g. +15551234567.')).toBeInTheDocument();
    expect(screen.getByText('Use the two-letter country code, e.g. US.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
