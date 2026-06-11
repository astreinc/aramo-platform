import { Injectable } from '@nestjs/common';

import type { AddressLookupProvider } from './providers/address-lookup.port.js';
import { GoogleAddressLookupProvider } from './providers/google-address-lookup.provider.js';
import { MockAddressLookupProvider } from './providers/mock-address-lookup.provider.js';
import type { AddressSuggestionDto } from './dto/address-suggestion.dto.js';
import type { AddressDetailsDto } from './dto/address-details.dto.js';

// AddressLookupService — provider selection + the enablement gate
// (Address-Autocomplete v1.0).
//
// Selection (ADDRESS_AUTOCOMPLETE_PROVIDER, default "google"): "mock" picks
// the canned adapter (tests / CI); anything else picks the live Google
// adapter. Read per-call so a test can flip the env without re-instantiating
// the Nest container.
//
// Enablement (ADDRESS_AUTOCOMPLETE_ENABLED): when not exactly "true" the
// feature is OFF — autocomplete returns [] and details returns null, with NO
// provider call. This is a plain process.env boolean (the established config
// pattern — there is no feature-flag framework); it lets the feature ship
// dark and be turned on per-environment without a redeploy of code.
//
// This service does NOT catch provider errors — the controller owns the
// never-block empty-200 translation (so the distinction between "disabled"
// and "provider failed" stays at the HTTP boundary).
@Injectable()
export class AddressLookupService {
  private readonly google: AddressLookupProvider = new GoogleAddressLookupProvider();
  private readonly mock: AddressLookupProvider = new MockAddressLookupProvider();

  isEnabled(): boolean {
    return process.env['ADDRESS_AUTOCOMPLETE_ENABLED'] === 'true';
  }

  private provider(): AddressLookupProvider {
    const name = process.env['ADDRESS_AUTOCOMPLETE_PROVIDER'] ?? 'google';
    return name === 'mock' ? this.mock : this.google;
  }

  async autocomplete(
    query: string,
    signal?: AbortSignal,
  ): Promise<AddressSuggestionDto[]> {
    if (!this.isEnabled()) return [];
    return this.provider().autocomplete(query, signal);
  }

  async details(
    placeId: string,
    signal?: AbortSignal,
  ): Promise<AddressDetailsDto | null> {
    if (!this.isEnabled()) return null;
    return this.provider().details(placeId, signal);
  }
}
