// Assignments roster sources.
//
// §5 Auth-Hardening D4c — the USER roster here is RETIRED: the assign-a-teammate
// pickers source users/users-api.ts (fetchAssignableUsers for the picker,
// resolveUserNames for names). What remains is the COMPANY roster (team-clients
// picker), an adapter over companies/companies-api.ts `listCompanies()`.

import { ApiError } from '@aramo/fe-foundation';

import { listCompanies } from '../companies/companies-api';

// ─── Company roster (team-clients) ────────────────────────────────────
//
// The picker reads only id/name/city/state. GET /v1/companies is company:read +
// visibility-resolved (the scoping mismatch documented in TeamClientsView).
export interface CompanyPickerView {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly state: string | null;
}

export type CompanyListState =
  | { state: 'ready'; companies: readonly CompanyPickerView[] }
  | { state: 'forbidden' };

// Adapter over the shared listCompanies() — NOT a second fetcher. listCompanies
// throws on non-2xx; a 403 (caller lacks company:read) degrades to forbidden so
// the consumer falls back to a raw-UUID input.
export async function probeCompanyList(): Promise<CompanyListState> {
  try {
    const view = await listCompanies();
    return {
      state: 'ready',
      companies: view.items.map((c) => ({
        id: c.id,
        name: c.name,
        city: c.city,
        state: c.state,
      })),
    };
  } catch (err: unknown) {
    if (err instanceof ApiError && err.status === 403) {
      return { state: 'forbidden' };
    }
    throw err;
  }
}
