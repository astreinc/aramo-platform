import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleAddressLookupProvider } from '../lib/providers/google-address-lookup.provider.js';
import { MockAddressLookupProvider } from '../lib/providers/mock-address-lookup.provider.js';
import { AddressLookupService } from '../lib/address-lookup.service.js';

// Address-Autocomplete v1.0 — §4 LOAD-BEARING gate 3 (provider-abstraction)
// + the mocked-fetch Google adapter unit (directive R2). The mock path proves
// the route/DTO mapping with NO key + NO network; the Google path proves the
// Places→DTO mapping, the error path, and that the KEY is sent only in the
// request header and never surfaces in a thrown error (R10).

const TEST_KEY = 'test-places-key-do-not-log';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('MockAddressLookupProvider', () => {
  const mock = new MockAddressLookupProvider();

  it('returns the canned Googleplex suggestion for a "mountain view" query', async () => {
    const out = await mock.autocomplete('1600 amphitheatre mountain view');
    expect(out).toHaveLength(1);
    expect(out[0].place_id).toBe('mock-place-googleplex');
    expect(out[0].primary_text).toContain('Amphitheatre');
  });

  it('resolves canned structured details (incl. ISO-2 country) by place_id', async () => {
    const d = await mock.details('mock-place-googleplex');
    expect(d).toMatchObject({
      provider: 'mock',
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
      country: 'US',
    });
  });
});

describe('GoogleAddressLookupProvider (mocked fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env['GOOGLE_PLACES_API_KEY'] = TEST_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GOOGLE_PLACES_API_KEY'];
  });

  it('maps a Places autocomplete response into AddressSuggestionDto[]', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        suggestions: [
          {
            placePrediction: {
              placeId: 'gpid-1',
              text: { text: '1600 Amphitheatre Pkwy, Mountain View, CA, USA' },
              structuredFormat: {
                mainText: { text: '1600 Amphitheatre Pkwy' },
                secondaryText: { text: 'Mountain View, CA, USA' },
              },
            },
          },
          { placePrediction: { /* no placeId → dropped */ } },
        ],
      }),
    );
    const provider = new GoogleAddressLookupProvider();
    const out = await provider.autocomplete('1600 amph');
    expect(out).toEqual([
      {
        place_id: 'gpid-1',
        description: '1600 Amphitheatre Pkwy, Mountain View, CA, USA',
        primary_text: '1600 Amphitheatre Pkwy',
        secondary_text: 'Mountain View, CA, USA',
      },
    ]);
    // The key is sent ONLY in the request header.
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe(TEST_KEY);
  });

  it('maps Places addressComponents into structured details with ISO-2 country', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        addressComponents: [
          { longText: '1600', types: ['street_number'] },
          { longText: 'Amphitheatre Parkway', types: ['route'] },
          { longText: 'Mountain View', types: ['locality'] },
          { longText: 'California', shortText: 'CA', types: ['administrative_area_level_1'] },
          { longText: '94043', types: ['postal_code'] },
          { longText: 'United States', shortText: 'US', types: ['country'] },
        ],
      }),
    );
    const provider = new GoogleAddressLookupProvider();
    const d = await provider.details('gpid-1');
    expect(d).toEqual({
      place_id: 'gpid-1',
      provider: 'google',
      address: '1600 Amphitheatre Parkway',
      address2: null,
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
      country: 'US',
    });
  });

  it('throws a STATUS-ONLY error (no key) on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'denied' }, false, 403));
    const provider = new GoogleAddressLookupProvider();
    await expect(provider.autocomplete('boom')).rejects.toThrow(
      'google-places-autocomplete-status-403',
    );
    // The thrown message must NOT leak the key.
    await expect(provider.details('x').catch((e: Error) => e.message)).resolves.not.toContain(
      TEST_KEY,
    );
  });

  it('throws a clear error when the Google key is not configured', async () => {
    delete process.env['GOOGLE_PLACES_API_KEY'];
    const provider = new GoogleAddressLookupProvider();
    await expect(provider.autocomplete('anything')).rejects.toThrow(
      'GOOGLE_PLACES_API_KEY is not configured',
    );
  });

  // --- Address-Autocomplete v1.1 — session token threading -----------------

  it('puts a present sessionToken in the autocomplete POST body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [] }));
    const provider = new GoogleAddressLookupProvider();
    await provider.autocomplete('1600 amph', 'sess-abc');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string) as { input: string; sessionToken?: string };
    expect(body.sessionToken).toBe('sess-abc');
    expect(body.input).toBe('1600 amph');
  });

  it('OMITS sessionToken from the autocomplete body when absent (non-breaking)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ suggestions: [] }));
    const provider = new GoogleAddressLookupProvider();
    await provider.autocomplete('1600 amph');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('sessionToken' in body).toBe(false);
  });

  it('puts a present sessionToken on the details query string; omits when absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ addressComponents: [] }));
    const provider = new GoogleAddressLookupProvider();
    await provider.details('gpid-1', 'sess-abc');
    expect(String(fetchMock.mock.calls[0][0])).toContain('sessionToken=sess-abc');
    await provider.details('gpid-1');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('sessionToken');
  });

  it('never leaks the sessionToken (nor the key) in a thrown error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'denied' }, false, 403));
    const provider = new GoogleAddressLookupProvider();
    const msg = await provider
      .autocomplete('boom', 'sess-secret-xyz')
      .catch((e: Error) => e.message);
    expect(msg).not.toContain('sess-secret-xyz');
    expect(msg).not.toContain(TEST_KEY);
  });
});

describe('AddressLookupService — enablement + provider selection', () => {
  afterEach(() => {
    delete process.env['ADDRESS_AUTOCOMPLETE_ENABLED'];
    delete process.env['ADDRESS_AUTOCOMPLETE_PROVIDER'];
  });

  it('returns [] / null with NO provider call when disabled', async () => {
    process.env['ADDRESS_AUTOCOMPLETE_ENABLED'] = 'false';
    process.env['ADDRESS_AUTOCOMPLETE_PROVIDER'] = 'mock';
    const svc = new AddressLookupService();
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.autocomplete('mountain view')).toEqual([]);
    expect(await svc.details('mock-place-googleplex')).toBeNull();
  });

  it('routes to the mock adapter when enabled + PROVIDER=mock', async () => {
    process.env['ADDRESS_AUTOCOMPLETE_ENABLED'] = 'true';
    process.env['ADDRESS_AUTOCOMPLETE_PROVIDER'] = 'mock';
    const svc = new AddressLookupService();
    const out = await svc.autocomplete('mountain view');
    expect(out[0].place_id).toBe('mock-place-googleplex');
    const d = await svc.details('mock-place-googleplex');
    expect(d?.provider).toBe('mock');
  });
});
