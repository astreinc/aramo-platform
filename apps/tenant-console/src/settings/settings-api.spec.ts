import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchTenantSettings, setTenantSetting } from './settings-api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings-api', () => {
  it('fetches the tenant settings view from GET /v1/tenant/settings', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'compensation.display_default': 'both',
            'audit.financials_enabled': false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const view = await fetchTenantSettings();
    expect(view['compensation.display_default']).toBe('both');
    expect(view['audit.financials_enabled']).toBe(false);
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(url).toBe('/v1/tenant/settings');
  });

  it('writes a setting to PUT /v1/tenant/settings/:key with the encoded key', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            key: 'compensation.display_default',
            value: 'markup',
            previous_value: 'both',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const result = await setTenantSetting(
      'compensation.display_default',
      'markup',
    );
    expect(result.value).toBe('markup');
    expect(result.previous_value).toBe('both');
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('/v1/tenant/settings/compensation.display_default');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ value: 'markup' }));
  });
});
