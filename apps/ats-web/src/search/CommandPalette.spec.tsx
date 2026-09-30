import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './CommandPalette';
import type { SearchResults } from './enterprise-search-api';

// Enterprise Search GS-1 — the ⌘K palette proofs. The palette is a LEAN consumer of the same
// /v1/search contract as SearchView (shared hook) — keyboard-first, grouped, navigate-and-go.

const RESULTS: SearchResults = {
  query: 'eng',
  groups: [
    { entity_type: 'TALENT', hits: [{ entity_type: 'TALENT', entity_id: 'tal-1', display_label: 'Jane Doe', subtitle: 'Engineer', snippet: null, route: '/talent/tal-1', match: { signal: 'lexical', relevance: 0.5 } }] },
    { entity_type: 'REQUISITION', hits: [{ entity_type: 'REQUISITION', entity_id: 'req-1', display_label: 'Senior Role', subtitle: 'REQ-1042', snippet: null, route: '/requisitions/req-1', match: { signal: 'exact', relevance: 1 } }] },
  ],
};

function mockSearch(handler: (url: string) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/search')) return handler(url);
    return new Response('{}', { status: 404 });
  });
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderPalette(open = true) {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter initialEntries={['/desk']}>
      <CommandPalette open={open} onOpenChange={onOpenChange} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { onOpenChange };
}

describe('CommandPalette — ⌘K', () => {
  afterEach(() => vi.restoreAllMocks());

  it('closed → renders nothing', () => {
    mockSearch(() => ok(RESULTS));
    renderPalette(false);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('open + empty → prompt; no call', () => {
    const spy = mockSearch(() => ok(RESULTS));
    renderPalette();
    expect(screen.getByTestId('cmdk-prompt')).toBeInTheDocument();
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('/v1/search'))).toHaveLength(0);
  });

  it('typing → one /v1/search call and grouped options', async () => {
    const spy = mockSearch(() => ok(RESULTS));
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eng' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Jane Doe/ })).toBeInTheDocument());
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('/v1/search'))).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Senior Role/ })).toBeInTheDocument();
  });

  it('ArrowDown + Enter navigates to the active hit and closes', async () => {
    const { onOpenChange } = renderPalette();
    mockSearch(() => ok(RESULTS));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'eng' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Jane Doe/ })).toBeInTheDocument());
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // active 0 → 1 (Senior Role)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/requisitions/req-1'));
  });

  it('clicking an option navigates and closes', async () => {
    const { onOpenChange } = renderPalette();
    mockSearch(() => ok(RESULTS));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eng' } });
    const opt = await screen.findByRole('option', { name: /Jane Doe/ });
    fireEvent.click(opt);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/talent/tal-1'));
  });

  it('server error → error state (not silent empty)', async () => {
    mockSearch(() => new Response('{}', { status: 500 }));
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eng' } });
    await waitFor(() => expect(screen.getByTestId('cmdk-error')).toBeInTheDocument());
  });

  it('empty results → empty state', async () => {
    mockSearch(() => ok({ query: 'zzz', groups: [] }));
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByTestId('cmdk-empty')).toBeInTheDocument());
  });
});
