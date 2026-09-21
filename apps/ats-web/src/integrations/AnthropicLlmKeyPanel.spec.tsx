import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AnthropicLlmKeyPanel } from './AnthropicLlmKeyPanel';

// TENANT-LLM-1 — least-visibility + write-only proofs for the Anthropic key panel.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

function renderPanel(session: Session | null, over: Partial<Parameters<typeof AnthropicLlmKeyPanel>[0]> = {}) {
  const loadFn = over.loadFn ?? vi.fn().mockResolvedValue({ provider: 'anthropic', configured: false });
  const setFn = over.setFn ?? vi.fn().mockResolvedValue({ provider: 'anthropic', configured: true });
  const clearFn = over.clearFn ?? vi.fn().mockResolvedValue({ provider: 'anthropic', configured: false });
  const utils = render(
    <ToastProvider>
      <AnthropicLlmKeyPanel sessionOverride={session ?? undefined} loadFn={loadFn} setFn={setFn} clearFn={clearFn} />
    </ToastProvider>,
  );
  return { ...utils, loadFn, setFn, clearFn };
}

describe('AnthropicLlmKeyPanel', () => {
  it('renders NOTHING and makes NO fetch without integration:read', () => {
    const loadFn = vi.fn();
    const { container } = renderPanel(makeSession([]), { loadFn });
    expect(container).toBeEmptyDOMElement();
    expect(loadFn).not.toHaveBeenCalled();
  });

  it('read-only: shows status, NO write controls', async () => {
    renderPanel(makeSession(['integration:read']), {
      loadFn: vi.fn().mockResolvedValue({ provider: 'anthropic', configured: true }),
    });
    await waitFor(() => expect(screen.getByTestId('anthropic-key-status')).toHaveTextContent('Configured'));
    expect(screen.queryByTestId('anthropic-key-input')).toBeNull();
    expect(screen.queryByTestId('anthropic-key-save')).toBeNull();
  });

  it('write: sets the key, clears the input, and never renders the value', async () => {
    const setFn = vi.fn().mockResolvedValue({ provider: 'anthropic', configured: true });
    renderPanel(makeSession(['integration:read', 'integration:write']), { setFn });
    const input = (await screen.findByTestId('anthropic-key-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-ant-super-secret' } });
    fireEvent.click(screen.getByTestId('anthropic-key-save'));
    await waitFor(() => expect(setFn).toHaveBeenCalledWith('sk-ant-super-secret'));
    // Input cleared after save; the value is never shown anywhere.
    await waitFor(() => expect((screen.getByTestId('anthropic-key-input') as HTMLInputElement).value).toBe(''));
    expect(document.body.textContent).not.toContain('sk-ant-super-secret');
  });

  it('write + configured: Clear calls clearFn', async () => {
    const clearFn = vi.fn().mockResolvedValue({ provider: 'anthropic', configured: false });
    renderPanel(makeSession(['integration:read', 'integration:write']), {
      loadFn: vi.fn().mockResolvedValue({ provider: 'anthropic', configured: true }),
      clearFn,
    });
    fireEvent.click(await screen.findByTestId('anthropic-key-clear'));
    await waitFor(() => expect(clearFn).toHaveBeenCalled());
  });
});
