import type { AddressDetailsDto } from '../dto/address-details.dto.js';
import type { AddressSuggestionDto } from '../dto/address-suggestion.dto.js';

import type { AddressLookupProvider } from './address-lookup.port.js';

// MockAddressLookupProvider — the test/CI adapter (Address-Autocomplete v1.0).
//
// Selected when ADDRESS_AUTOCOMPLETE_PROVIDER=mock. It exists so the route /
// DTO / FE-populate path can be exercised end-to-end with NO billing key and
// NO live network call — the only way "Google is the live default" and "green
// CI without a Places key" coexist (directive R2). NOT wired in real
// environments (Google is live there).
//
// Deterministic: a query containing "mountain view" (any case) returns the
// canned Googleplex suggestion; any other ≥3-char query returns a single
// echo suggestion so the typeahead always has something to render in tests.
export class MockAddressLookupProvider implements AddressLookupProvider {
  readonly name = 'mock';

  private static readonly GOOGLEPLEX_PLACE_ID = 'mock-place-googleplex';

  // Address-Autocomplete v1.1 — the mock IGNORES the session token (tests stay
  // key-free + network-free); the signature matches the port so a token-passing
  // caller works unchanged.
  async autocomplete(
    query: string,
    _sessionToken?: string,
  ): Promise<AddressSuggestionDto[]> {
    const q = query.trim();
    if (q.toLowerCase().includes('mountain view')) {
      return [
        {
          place_id: MockAddressLookupProvider.GOOGLEPLEX_PLACE_ID,
          description: '1600 Amphitheatre Pkwy, Mountain View, CA, USA',
          primary_text: '1600 Amphitheatre Pkwy',
          secondary_text: 'Mountain View, CA, USA',
        },
      ];
    }
    return [
      {
        place_id: `mock-place-${encodeURIComponent(q.toLowerCase())}`,
        description: `${q} (mock result)`,
        primary_text: q,
        secondary_text: 'Mockville, MK, USA',
      },
    ];
  }

  async details(
    placeId: string,
    _sessionToken?: string,
  ): Promise<AddressDetailsDto> {
    if (placeId === MockAddressLookupProvider.GOOGLEPLEX_PLACE_ID) {
      return {
        place_id: placeId,
        provider: this.name,
        address: '1600 Amphitheatre Pkwy',
        address2: null,
        city: 'Mountain View',
        state: 'CA',
        zip: '94043',
        country: 'US',
      };
    }
    return {
      place_id: placeId,
      provider: this.name,
      address: '1 Mock Street',
      address2: null,
      city: 'Mockville',
      state: 'MK',
      zip: '00000',
      country: 'US',
    };
  }
}
