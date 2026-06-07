// Settings S5c-3 — company-list probe + minimal CompanyView mirror.
//
// PL-94 §2 ruling 5 — a NEW shared probe for the team-clients editor's
// company-picker. Mirrors the S5c-2 probeUserRoster() shape exactly:
// try-read GET /v1/companies; on 200 return { state:'ready', companies };
// on 403 return { state:'forbidden' } so the consumer degrades to a raw-
// UUID input. Any OTHER error rethrows.
//
// THE SCOPING MISMATCH (carried — PL-94 §2 ruling 2): GET /v1/companies
// is `company:read` + visibility-resolved. The team-clients mutate is
// `team:manage` + tenant-wide. A team:manage holder with narrow company-
// visibility may not see every company they can assign — the team-
// clients editor renders an inline limitation note ("Only companies
// visible to you are listed"), and the proper fix is filed as the
// follow-up `GET /v1/companies/assignable` (NOT built in S5c-3).

import { ApiError, apiClient } from '../api/client';

export const COMPANIES_PATH = '/v1/companies';

// Hand-mirrored from libs/company/src/lib/dto/company.view.ts (NO
// @aramo/* import). We mirror only the fields the picker uses; the
// full CompanyView has many address/phone/legal fields the team-
// clients editor does not consume.
export interface CompanyPickerView {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly state: string | null;
}

export type CompanyListState =
  | { state: 'ready'; companies: readonly CompanyPickerView[] }
  | { state: 'forbidden' };

interface MinimalCompaniesView {
  readonly items?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly city?: string | null;
    readonly state?: string | null;
  }>;
}

export async function probeCompanyList(): Promise<CompanyListState> {
  try {
    const view = await apiClient.get<MinimalCompaniesView>(COMPANIES_PATH);
    const companies = (view.items ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city ?? null,
      state: c.state ?? null,
    }));
    return { state: 'ready', companies };
  } catch (err: unknown) {
    if (err instanceof ApiError && err.status === 403) {
      return { state: 'forbidden' };
    }
    throw err;
  }
}
