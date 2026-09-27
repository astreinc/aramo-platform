import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LlmProvidersPanel } from './LlmProvidersPanel';
import type { TenantLlmOverview } from './llm-providers-api';

// TENANT-LLM-2 — multi-provider BYO LLM panel: least-visibility gating,
// write-only keys (no value render), no-dead-knobs (coming-soon not selectable),
// active-provider selection + set/rotate/clear the active provider's key.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const OVERVIEW: TenantLlmOverview = {
  active_provider: 'anthropic',
  providers: [
    { provider: 'anthropic', configured: true },
    { provider: 'openai', configured: false },
  ],
};

function renderPanel(props: Parameters<typeof LlmProvidersPanel>[0]) {
  return render(
    <ToastProvider>
      <LlmProvidersPanel {...props} />
    </ToastProvider>,
  );
}

describe('LlmProvidersPanel — least-visibility', () => {
  it('renders nothing and makes NO fetch without integration:read', () => {
    const loadFn = vi.fn();
    renderPanel({ sessionOverride: makeSession(['requisition:import:read']), loadFn });
    expect(screen.queryByTestId('llm-active-provider')).not.toBeInTheDocument();
    expect(loadFn).not.toHaveBeenCalled();
  });
});

describe('LlmProvidersPanel — read-only', () => {
  it('shows the active provider + per-provider status, NO write affordances', async () => {
    const loadFn = vi.fn().mockResolvedValue(OVERVIEW);
    renderPanel({ sessionOverride: makeSession(['integration:read']), loadFn });

    // Active provider carries the ACTIVE · CONFIGURED tag; a wired-but-inactive,
    // unconfigured provider is a supported-but-not-selected row.
    await waitFor(() =>
      expect(screen.getByTestId('llm-status-anthropic')).toHaveTextContent('ACTIVE · CONFIGURED'),
    );
    expect(screen.getByTestId('llm-status-openai')).toHaveTextContent('Supported');
    // Active radio reflects the server; radios are disabled (no write scope).
    expect(screen.getByTestId('llm-active-anthropic')).toBeChecked();
    expect(screen.getByTestId('llm-active-anthropic')).toBeDisabled();
    // No key controls without write scope.
    expect(screen.queryByTestId('llm-key-input-anthropic')).not.toBeInTheDocument();
    expect(screen.queryByTestId('llm-key-save-anthropic')).not.toBeInTheDocument();
  });

  it('renders coming-soon providers as disabled, NOT selectable (no dead knobs)', async () => {
    const loadFn = vi.fn().mockResolvedValue(OVERVIEW);
    renderPanel({ sessionOverride: makeSession(['integration:read']), loadFn });
    await waitFor(() => expect(screen.getByTestId('llm-comingsoon-gemini')).toBeInTheDocument());
    expect(screen.getByTestId('llm-comingsoon-azure')).toBeDisabled();
    expect(screen.getByTestId('llm-comingsoon-bedrock')).toBeDisabled();
  });
});

describe('LlmProvidersPanel — write', () => {
  it('rotates the ACTIVE provider key (write-only — value never rendered back)', async () => {
    const loadFn = vi.fn().mockResolvedValue(OVERVIEW);
    const setKeyFn = vi.fn().mockResolvedValue({ configured: true });
    renderPanel({ sessionOverride: makeSession(['integration:read', 'integration:write']), loadFn, setKeyFn });

    // Anthropic is the active provider → its key row is shown.
    const input = await screen.findByTestId('llm-key-input-anthropic');
    fireEvent.change(input, { target: { value: 'sk-ant-secret' } });
    fireEvent.click(screen.getByTestId('llm-key-save-anthropic'));

    await waitFor(() => expect(setKeyFn).toHaveBeenCalledWith('anthropic', 'sk-ant-secret'));
    // The value is cleared from the field after save (never retained/rendered).
    await waitFor(() => expect(screen.getByTestId('llm-key-input-anthropic')).toHaveValue(''));
  });

  it('selects a provider, then sets THAT provider key (select → key flow)', async () => {
    const loadFn = vi.fn().mockResolvedValue(OVERVIEW);
    const setActiveFn = vi.fn().mockResolvedValue({ ...OVERVIEW, active_provider: 'openai' });
    const setKeyFn = vi.fn().mockResolvedValue({ configured: true });
    renderPanel({
      sessionOverride: makeSession(['integration:read', 'integration:write']),
      loadFn,
      setActiveFn,
      setKeyFn,
    });

    // Select OpenAI → it becomes active → its (unconfigured) key row appears.
    const openaiRadio = await screen.findByTestId('llm-active-openai');
    fireEvent.click(openaiRadio);
    await waitFor(() => expect(setActiveFn).toHaveBeenCalledWith('openai'));

    const input = await screen.findByTestId('llm-key-input-openai');
    fireEvent.change(input, { target: { value: 'sk-secret-openai' } });
    fireEvent.click(screen.getByTestId('llm-key-save-openai'));
    await waitFor(() => expect(setKeyFn).toHaveBeenCalledWith('openai', 'sk-secret-openai'));
  });

  it('selects the active provider via the resolver-backed endpoint', async () => {
    const loadFn = vi.fn().mockResolvedValue(OVERVIEW);
    const setActiveFn = vi.fn().mockResolvedValue({ ...OVERVIEW, active_provider: 'openai' });
    renderPanel({ sessionOverride: makeSession(['integration:read', 'integration:write']), loadFn, setActiveFn });

    const openaiRadio = await screen.findByTestId('llm-active-openai');
    fireEvent.click(openaiRadio);
    await waitFor(() => expect(setActiveFn).toHaveBeenCalledWith('openai'));
    await waitFor(() => expect(screen.getByTestId('llm-active-openai')).toBeChecked());
  });

  it('clears the active configured provider key', async () => {
    const loadFn = vi.fn().mockResolvedValue(OVERVIEW);
    const clearFn = vi.fn().mockResolvedValue({ configured: false });
    renderPanel({ sessionOverride: makeSession(['integration:read', 'integration:write']), loadFn, clearFn });

    const clearBtn = await screen.findByTestId('llm-key-clear-anthropic');
    fireEvent.click(clearBtn);
    await waitFor(() => expect(clearFn).toHaveBeenCalledWith('anthropic'));
  });
});
