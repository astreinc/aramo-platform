import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ESignatureProvidersPanel } from './ESignatureProvidersPanel';
import type { ESignatureOverview, SignatureAllowance } from './esignature-api';

// Multi-Provider E-Sign §E/§H — the E-Signature panel renders the backend's
// decision: least-visibility, allowance used/remaining + renewal, the 80% and 100%
// states, no false "connected" for external providers, admin-only selection.

const session = (scopes: string[]): Session => ({ sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 });
const allowance = (used: number): SignatureAllowance => ({
  limit: 100,
  used,
  remaining: 100 - used,
  period_start: '2026-10-01T00:00:00.000Z',
  period_end: '2026-11-01T12:00:00.000Z',
  threshold: used >= 100 ? 'EXHAUSTED' : used >= 80 ? 'WARNING' : 'OK',
});
function overview(over: Partial<ESignatureOverview> = {}, used = 12): ESignatureOverview {
  return {
    active_provider: 'aramo_sign',
    providers: [
      { provider: 'aramo_sign', status: 'BUILT_IN', selectable: true, connectable: false, needs_reconnect: false },
      { provider: 'docusign', status: 'NOT_AVAILABLE', selectable: false, connectable: false, needs_reconnect: false },
      { provider: 'adobe_sign', status: 'NOT_AVAILABLE', selectable: false, connectable: false, needs_reconnect: false },
    ],
    availability: { provider: 'aramo_sign', available: used < 100, reason: used < 100 ? null : 'LIMIT_REACHED', allowance: allowance(used) },
    recent_changes: [],
    ...over,
  };
}
const renderPanel = (props: Parameters<typeof ESignatureProvidersPanel>[0]) =>
  render(
    <ToastProvider>
      <ESignatureProvidersPanel {...props} />
    </ToastProvider>,
  );

describe('ESignatureProvidersPanel', () => {
  it('renders nothing and makes no fetch without integration:read', () => {
    const loadFn = vi.fn();
    renderPanel({ sessionOverride: session(['document:read']), loadFn });
    expect(screen.queryByTestId('esign-active-provider')).not.toBeInTheDocument();
    expect(loadFn).not.toHaveBeenCalled();
  });

  it('shows the active provider and the allowance used, remaining and renewal date', async () => {
    renderPanel({ sessionOverride: session(['integration:read']), loadFn: async () => overview(), connectOutcome: null });
    expect(await screen.findByTestId('esign-allowance')).toHaveTextContent('12 of 100 used · renews');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12');
    expect(screen.getByTestId('esign-status-aramo_sign')).toHaveTextContent('ACTIVE');
  });

  it('warns at 80% and explains the pause at 100% without offering a purchase', async () => {
    const { unmount } = renderPanel({ sessionOverride: session(['integration:read']), loadFn: async () => overview({}, 82) });
    expect(await screen.findByText(/18 envelopes left this period/)).toHaveAttribute('role', 'status');
    unmount();
    renderPanel({ sessionOverride: session(['integration:read']), loadFn: async () => overview({}, 100) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('All 100 envelopes are used');
    expect(alert).toHaveTextContent('contact your Aramo account team');
    expect(alert).toHaveTextContent('Documents a client requires stay required');
  });

  it('an unlimited plan shows the count with no meter and no pause message (Commercial Plans Amendment A1)', async () => {
    const o = overview({}, 150);
    const unlimited = { ...o, availability: { ...o.availability, allowance: { ...o.availability.allowance!, limit: null, unlimited: true, remaining: null, threshold: 'OK' as const } } };
    renderPanel({ sessionOverride: session(['integration:read']), loadFn: async () => unlimited });
    expect(await screen.findByTestId('esign-allowance')).toHaveTextContent('150 sent · unlimited');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a tenant without Aramo Sign is told it is not in the plan', async () => {
    renderPanel({
      sessionOverride: session(['integration:read']),
      loadFn: async () => overview({ availability: { provider: 'aramo_sign', available: false, reason: 'NOT_SUBSCRIBED', allowance: null } }),
    });
    expect(await screen.findByTestId('esign-not-subscribed')).toHaveTextContent("isn't part of your plan");
    expect(screen.queryByTestId('esign-allowance')).not.toBeInTheDocument();
  });

  it('never presents DocuSign or Adobe as connected or selectable before their integration exists', async () => {
    renderPanel({ sessionOverride: session(['integration:read', 'integration:write']), loadFn: async () => overview() });
    await screen.findByTestId('esign-active-provider');
    expect(screen.getByTestId('esign-provider-docusign')).toBeDisabled();
    expect(screen.getByTestId('esign-provider-adobe_sign')).toBeDisabled();
    expect(screen.getByTestId('esign-status-docusign')).toHaveTextContent('Not available yet');
    expect(screen.queryByText(/^Connected$/)).not.toBeInTheDocument();
  });

  it('only integration:write can change the provider', async () => {
    const selectFn = vi.fn(async () => overview({ active_provider: 'docusign' }));
    const ov = overview({ active_provider: 'docusign', providers: [
      { provider: 'aramo_sign', status: 'BUILT_IN', selectable: true, connectable: false, needs_reconnect: false },
      { provider: 'docusign', status: 'CONNECTED', selectable: true, connectable: true, needs_reconnect: false },
      { provider: 'adobe_sign', status: 'NOT_AVAILABLE', selectable: false, connectable: false, needs_reconnect: false },
    ] });
    const { unmount } = renderPanel({ sessionOverride: session(['integration:read']), loadFn: async () => ov, selectFn });
    expect(await screen.findByTestId('esign-provider-aramo_sign')).toBeDisabled();
    unmount();
    renderPanel({ sessionOverride: session(['integration:read', 'integration:write']), loadFn: async () => ov, selectFn });
    fireEvent.click(await screen.findByTestId('esign-provider-aramo_sign'));
    await waitFor(() => expect(selectFn).toHaveBeenCalledWith('aramo_sign'));
  });

  it('an admin can connect a configured provider: the browser goes to the provider sign-in', async () => {
    const navigate = vi.fn();
    const connectFn = vi.fn(async () => ({ authorize_url: 'https://account-d.docusign.com/oauth/auth?state=s' }));
    const ov = overview({ providers: [
      { provider: 'aramo_sign', status: 'BUILT_IN', selectable: true, connectable: false, needs_reconnect: false },
      { provider: 'docusign', status: 'NOT_CONNECTED', selectable: false, connectable: true, needs_reconnect: true },
      { provider: 'adobe_sign', status: 'NOT_AVAILABLE', selectable: false, connectable: false, needs_reconnect: false },
    ] });
    renderPanel({ sessionOverride: session(['integration:read', 'integration:write']), loadFn: async () => ov, connectFn, navigate, connectOutcome: null });
    expect(await screen.findByTestId('esign-status-docusign')).toHaveTextContent('Reconnect needed');
    fireEvent.click(screen.getByTestId('esign-connect-docusign'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://account-d.docusign.com/oauth/auth?state=s'));
    expect(connectFn).toHaveBeenCalledWith('docusign');
    expect(screen.queryByTestId('esign-connect-adobe_sign')).not.toBeInTheDocument();
  });

  it('a connected provider offers Disconnect to admins only', async () => {
    const disconnectFn = vi.fn(async () => overview());
    const ov = overview({ providers: [
      { provider: 'aramo_sign', status: 'BUILT_IN', selectable: true, connectable: false, needs_reconnect: false },
      { provider: 'docusign', status: 'CONNECTED', selectable: true, connectable: true, needs_reconnect: false },
      { provider: 'adobe_sign', status: 'NOT_AVAILABLE', selectable: false, connectable: false, needs_reconnect: false },
    ] });
    const { unmount } = renderPanel({ sessionOverride: session(['integration:read']), loadFn: async () => ov, connectOutcome: null });
    await screen.findByTestId('esign-active-provider');
    expect(screen.queryByTestId('esign-disconnect-docusign')).not.toBeInTheDocument();
    unmount();
    renderPanel({ sessionOverride: session(['integration:read', 'integration:write']), loadFn: async () => ov, disconnectFn, connectOutcome: null });
    fireEvent.click(await screen.findByTestId('esign-disconnect-docusign'));
    await waitFor(() => expect(disconnectFn).toHaveBeenCalledWith('docusign'));
  });
});
