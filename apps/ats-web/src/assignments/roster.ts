// Assignments roster sources (FE Consolidation Directive 4).
//
// The three assignment editors need two pickers: a tenant-user roster (company
// + requisition assign) and a company roster (team-clients). In tenant-console
// these came from its `users` and `companies` modules. In ats-web those
// fetchers ALREADY EXIST as shared sources — so this module does NOT duplicate
// a fetcher; it ADAPTS the existing ones to the shape the editors consume:
//   - user roster  → task/task-api.ts `probeTenantUsers()` (GET /v1/tenant/users)
//   - company roster → companies/companies-api.ts `listCompanies()` (GET /v1/companies)
//
// The editors (and their carried specs) consume `UserRosterState` /
// `CompanyListState` over the 403-degrade discriminated union (state:
// 'ready'|'forbidden'). Those are FE mirror TYPES (not fetchers), kept here so
// the specs' fixtures stay byte-identical (import path only). Each editor
// accepts a probe test-seam prop, so the specs inject their own rosters and are
// agnostic to the real source.

import { ApiError } from '@aramo/fe-foundation';

import { listCompanies } from '../companies/companies-api';
import { probeTenantUsers } from '../task/task-api';

// ─── User roster (company + requisition assign) ───────────────────────
//
// Mirror of the GET /v1/tenant/users row (S5-BE1). The editors read only
// user_id / display_name / email; the remaining fields are carried so the
// specs' full-row fixtures type-check unchanged. probeTenantUsers narrows the
// wire to {user_id,email,display_name,is_active}; the unused fields default.
export interface TenantUserView {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly is_active: boolean;
  readonly deactivated_at: string | null;
  readonly site_id: string | null;
  readonly role_keys: readonly string[];
}

export type UserRosterState =
  | { state: 'ready'; users: readonly TenantUserView[] }
  | { state: 'forbidden' };

// Adapter over the shared probeTenantUsers() — NOT a second fetcher. On a
// roster-unavailable (403/404) probe the consumer degrades to a raw-UUID input.
export async function probeUserRoster(): Promise<UserRosterState> {
  const res = await probeTenantUsers();
  if (!res.available) return { state: 'forbidden' };
  return {
    state: 'ready',
    users: res.items.map((u) => ({
      user_id: u.user_id,
      email: u.email,
      display_name: u.display_name,
      is_active: u.is_active,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    })),
  };
}

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
