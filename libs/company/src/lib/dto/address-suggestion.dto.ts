// AddressSuggestionDto — one autocomplete prediction returned by
// GET /v1/address-lookup/autocomplete.
//
// Address-Autocomplete v1.0. Provider-neutral shape: the GoogleAddressLookup
// adapter maps the Places `suggestions[].placePrediction` into this; the Mock
// adapter returns canned instances. `place_id` is the opaque provider
// reference passed back to /details; the provider that issued it is implicit
// in ADDRESS_AUTOCOMPLETE_PROVIDER and stamped on the resolved details.
export interface AddressSuggestionDto {
  /** Opaque provider place reference — passed to /details to resolve fields. */
  place_id: string;
  /** Full one-line label (e.g. "1600 Amphitheatre Pkwy, Mountain View, CA"). */
  description: string;
  /** Primary line (street / place name). */
  primary_text: string;
  /** Secondary line (city, region, country). */
  secondary_text: string;
}
