import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Dashboard welcome banner (handoff "Aramo Sign - dashboard banner", prototype
// #/app "Dashboard banner"): welcome line with the signed-in user's name, four
// quick actions in order, a Start menu, and "Sign Document" opening the first
// envelope waiting for this user's signature through the recipient-only link.

const list = vi.fn();
const sign = vi.fn();
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return { ...mod, inboxApi: { ...mod.inboxApi, list: (...a: unknown[]) => list(...a), sign: (...a: unknown[]) => sign(...a) } };
});
const ws = {
  base: '/sign',
  ctx: { can_send: true, workspace: 'sign', user: { id: 'u-1', email: 'p@example.com', display_name: 'Purush Pichaimuthu' } },
  toast: vi.fn(),
};
vi.mock('../workspace', () => ({ useWorkspace: () => ws }));

import { DashboardBanner } from './DashboardBanner';

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}
function show() {
  render(
    <MemoryRouter initialEntries={['/sign']}>
      <DashboardBanner />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const assign = vi.fn();
beforeEach(() => {
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
  ws.ctx = { ...ws.ctx, can_send: true, workspace: 'sign', user: { ...ws.ctx.user, display_name: 'Purush Pichaimuthu' } };
});
afterEach(() => vi.clearAllMocks());

describe('DashboardBanner', () => {
  it('welcomes the signed-in user by name, with no time-of-day greeting', () => {
    show();
    const h = screen.getByRole('heading', { level: 1 });
    expect(h.textContent).toBe('Welcome back, Purush Pichaimuthu');
    expect(screen.queryByText(/Good (morning|afternoon|evening)/)).toBeNull();
    expect(screen.queryByText(/what’s happening/)).toBeNull();
  });

  it('falls back to "Welcome back" without a display name', () => {
    ws.ctx = { ...ws.ctx, user: { ...ws.ctx.user, display_name: null } } as typeof ws.ctx;
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back');
  });

  it('renders the four actions in order with the designed targets', () => {
    show();
    const row = screen.getByTestId('dashboard-banner').querySelector('.sg-banner__row') as HTMLElement;
    const labels = Array.from(row.children).map((c) => (c.textContent ?? '').trim());
    expect(labels).toEqual(['Start', 'Use Envelope Template', 'Sign Document', 'Get Signatures']);
    expect(screen.getByRole('link', { name: 'Use Envelope Template' }).getAttribute('href')).toBe('/sign/templates');
    expect(screen.getByRole('link', { name: 'Get Signatures' }).getAttribute('href')).toBe('/sign/envelopes/new');
  });

  it('Start opens a menu with the four items and closes on Esc, returning focus', async () => {
    show();
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start.getAttribute('aria-haspopup')).toBe('menu');
    expect(start.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(start);
    expect(start.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem').map((i) => i.firstChild?.textContent);
    expect(items).toEqual(['Upload a document', 'Use a template', 'Sign a document', 'Get signatures']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(start);
  });

  it('closes the Start menu when the overlay is clicked', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByTestId('start-scrim'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Sign Document opens the first envelope waiting for this user via the recipient link', async () => {
    list.mockResolvedValue({ waiting: [{ id: 'i-0', can_sign: false }, { id: 'i-1', can_sign: true }], completed: [], other: [] });
    sign.mockResolvedValue({ signing_url: 'https://sign.aramo.ai/s/tok' });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Document' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://sign.aramo.ai/s/tok'));
    expect(sign).toHaveBeenCalledWith('i-1');
  });

  it('Sign Document goes to the "Waiting for me" inbox when nothing is waiting', async () => {
    list.mockResolvedValue({ waiting: [], completed: [], other: [] });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Document' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/sign/inbox'));
    expect(assign).not.toHaveBeenCalled();
  });

  it('hides template actions in a personal workspace (templates are not routed there)', () => {
    ws.ctx = { ...ws.ctx, workspace: 'personal' };
    show();
    expect(screen.queryByRole('link', { name: 'Use Envelope Template' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.queryByRole('menuitem', { name: /Use a template/ })).toBeNull();
  });

  it('disables the send actions when the user cannot send', () => {
    ws.ctx = { ...ws.ctx, can_send: false };
    show();
    expect(screen.queryByRole('link', { name: 'Get Signatures' })).toBeNull();
    const off = screen.getByText('Get Signatures').closest('[aria-disabled="true"]');
    expect(off).not.toBeNull();
    expect(off?.getAttribute('title')).toBe('You don’t have permission to send envelopes');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const disabled = screen.getAllByRole('menuitem').filter((i) => i.getAttribute('aria-disabled') === 'true').map((i) => i.firstChild?.textContent);
    expect(disabled).toEqual(['Upload a document', 'Get signatures']);
    // Sign Document stays enabled (§5a).
    expect(screen.getByRole('button', { name: 'Sign Document' }).getAttribute('aria-disabled')).toBeNull();
  });
});
