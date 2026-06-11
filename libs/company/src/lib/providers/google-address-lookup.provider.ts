import { Logger } from '@nestjs/common';

import type { AddressDetailsDto } from '../dto/address-details.dto.js';
import type { AddressSuggestionDto } from '../dto/address-suggestion.dto.js';

import type { AddressLookupProvider } from './address-lookup.port.js';

// GoogleAddressLookupProvider — the live adapter (Address-Autocomplete v1.0).
//
// Calls the Google Places API (New, v1):
//   - autocomplete → POST https://places.googleapis.com/v1/places:autocomplete
//   - details      → GET  https://places.googleapis.com/v1/places/{placeId}
//
// Outbound-call convention (the cognito-verifier / session-orchestrator
// pattern, extended): native `fetch`, no HTTP-client dependency. NEW here:
// an AbortController timeout (~4s) — the first user-blocking external call;
// a slow Places response must not hang the typeahead (directive R3). NO retry
// (retrying a keystroke is pointless — the next keystroke supersedes it).
//
// SECURITY (directive R10): the key is read from process.env at call time and
// sent ONLY in the X-Goog-Api-Key request header. It is NEVER returned to the
// caller, NEVER logged, and the raw provider payload is NEVER logged. Errors
// are logged as a short reason string only.
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_BASE_URL = 'https://places.googleapis.com/v1/places/';
const TIMEOUT_MS = 4000;

// --- Google response shapes (only the fields we read) -----------------------

interface GooglePlacePrediction {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
  };
}
interface GoogleAutocompleteResponse {
  suggestions?: GooglePlacePrediction[];
}
interface GoogleAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}
interface GooglePlaceDetailsResponse {
  addressComponents?: GoogleAddressComponent[];
}

export class GoogleAddressLookupProvider implements AddressLookupProvider {
  readonly name = 'google';
  private readonly logger = new Logger(GoogleAddressLookupProvider.name);

  // Read the key at call time (the cognito-verifier pattern) and throw a clear
  // error when Google is selected but no key is configured.
  private apiKey(): string {
    const key = process.env['GOOGLE_PLACES_API_KEY'];
    if (key === undefined || key.length === 0) {
      throw new Error('GOOGLE_PLACES_API_KEY is not configured');
    }
    return key;
  }

  async autocomplete(
    query: string,
    sessionToken?: string,
    signal?: AbortSignal,
  ): Promise<AddressSuggestionDto[]> {
    const key = this.apiKey();
    // Address-Autocomplete v1.1 — thread the session token into the request
    // body when present so this autocomplete + the matching details call bill
    // as ONE Google session. Absent → unchanged single-request behavior. The
    // token is request-only: never logged, never returned.
    const body: { input: string; sessionToken?: string } = { input: query };
    if (sessionToken !== undefined && sessionToken.length > 0) {
      body.sessionToken = sessionToken;
    }
    const res = await this.fetchWithTimeout(
      AUTOCOMPLETE_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
        },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (!res.ok) {
      // Status only — never the body (it can echo the request / key context).
      throw new Error(`google-places-autocomplete-status-${res.status}`);
    }
    const json = (await res.json()) as GoogleAutocompleteResponse;
    const suggestions = json.suggestions ?? [];
    return suggestions
      .map((s) => this.mapPrediction(s))
      .filter((s): s is AddressSuggestionDto => s !== null);
  }

  async details(
    placeId: string,
    sessionToken?: string,
    signal?: AbortSignal,
  ): Promise<AddressDetailsDto> {
    const key = this.apiKey();
    // Session token (v1.1) rides as a query param on details — it closes the
    // session opened by autocomplete (one billed session per lookup). Absent →
    // unchanged. Token is request-only: never logged, never returned.
    let url = `${DETAILS_BASE_URL}${encodeURIComponent(placeId)}`;
    if (sessionToken !== undefined && sessionToken.length > 0) {
      url = `${url}?${new URLSearchParams({ sessionToken }).toString()}`;
    }
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': key,
          // FieldMask keeps the call cheap + scoped to the address fields we
          // persist. addressComponents only — NO geometry (lat/lng deferred).
          'X-Goog-FieldMask': 'addressComponents',
        },
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(`google-places-details-status-${res.status}`);
    }
    const json = (await res.json()) as GooglePlaceDetailsResponse;
    return this.mapDetails(placeId, json.addressComponents ?? []);
  }

  // --- internals ------------------------------------------------------------

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    upstreamSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    // Honor an already-aborted upstream signal (the request was cancelled).
    if (upstreamSignal !== undefined) {
      if (upstreamSignal.aborted) controller.abort();
      else upstreamSignal.addEventListener('abort', () => controller.abort());
    }
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private mapPrediction(s: GooglePlacePrediction): AddressSuggestionDto | null {
    const p = s.placePrediction;
    if (p === undefined || p.placeId === undefined || p.placeId.length === 0) {
      return null;
    }
    const primary = p.structuredFormat?.mainText?.text ?? p.text?.text ?? '';
    const secondary = p.structuredFormat?.secondaryText?.text ?? '';
    const description = p.text?.text ?? [primary, secondary].filter(Boolean).join(', ');
    return {
      place_id: p.placeId,
      description,
      primary_text: primary,
      secondary_text: secondary,
    };
  }

  private mapDetails(
    placeId: string,
    components: GoogleAddressComponent[],
  ): AddressDetailsDto {
    const find = (type: string): GoogleAddressComponent | undefined =>
      components.find((c) => (c.types ?? []).includes(type));

    const streetNumber = find('street_number')?.longText ?? '';
    const route = find('route')?.longText ?? '';
    const address = [streetNumber, route].filter((p) => p !== '').join(' ');
    const subpremise = find('subpremise')?.longText ?? null;
    // locality is the canonical city; fall back to postal_town / sublocality.
    const city =
      find('locality')?.longText ??
      find('postal_town')?.longText ??
      find('sublocality')?.longText ??
      null;
    const state = find('administrative_area_level_1')?.shortText ?? null;
    const zip = find('postal_code')?.longText ?? null;
    // shortText on country is the ISO alpha-2 code (matches the FE vocabulary).
    const country = find('country')?.shortText ?? null;

    return {
      place_id: placeId,
      provider: this.name,
      address: address === '' ? null : address,
      address2: subpremise,
      city,
      state,
      zip,
      country,
    };
  }
}
