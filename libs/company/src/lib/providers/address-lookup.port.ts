import type { AddressSuggestionDto } from '../dto/address-suggestion.dto.js';
import type { AddressDetailsDto } from '../dto/address-details.dto.js';

// AddressLookupProvider — the provider port (Address-Autocomplete v1.0).
//
// The abstraction that lets the live Google adapter and the test mock be
// swapped by ADDRESS_AUTOCOMPLETE_PROVIDER without the service/controller
// knowing which is in play. A future vendor (Mapbox, HERE, …) implements this
// interface and slots in with no route or FE change.
//
// Both methods are best-effort from the caller's standpoint: the controller
// catches a throw/timeout and returns an empty-200 (the never-block
// invariant), so an implementation MAY throw on transport/quota failure.
export interface AddressLookupProvider {
  /** Stable provider key, stamped onto resolved details (e.g. "google"). */
  readonly name: string;

  /**
   * Resolve typeahead predictions for a partial address query. The `signal`
   * carries the caller's timeout (AbortController) — implementations pass it
   * to fetch so a slow provider is abandoned, not awaited indefinitely.
   */
  autocomplete(
    query: string,
    signal?: AbortSignal,
  ): Promise<AddressSuggestionDto[]>;

  /** Resolve the structured address fields for a previously-returned place. */
  details(placeId: string, signal?: AbortSignal): Promise<AddressDetailsDto>;
}
