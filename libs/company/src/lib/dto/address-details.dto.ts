// AddressDetailsDto — the resolved structured address returned by
// GET /v1/address-lookup/details.
//
// Address-Autocomplete v1.0. The keys map 1:1 onto the Company address block
// (address / address2 / city / state / zip / country) so the FE can populate
// the existing fields by name. `place_id` + `provider` are the reference the
// FE stamps onto the create body (Company.address_provider_place_id /
// .address_provider).
//
// NO geo: Google returns lat/lng on the place, but we deliberately do NOT map
// or persist them — that enrichment is deferred (carry).
export interface AddressDetailsDto {
  /** The provider place reference the details were resolved from. */
  place_id: string;
  /** Which provider issued the place_id (e.g. "google"). */
  provider: string;
  /** Street line (number + route). */
  address: string | null;
  /** Secondary line (suite / unit). */
  address2: string | null;
  city: string | null;
  /** Region / state (short form, e.g. "CA"). */
  state: string | null;
  zip: string | null;
  /** ISO 3166-1 alpha-2 (e.g. "US") — matches the FE country vocabulary. */
  country: string | null;
}
