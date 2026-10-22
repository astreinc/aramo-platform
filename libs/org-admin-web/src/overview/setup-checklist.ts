import { apiClient } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { fetchDomainVerification, type DomainVerificationView } from '../domain/domain-api';
import { fetchTenantProfile, type TenantProfileView } from '../profile/profile-api';
import { fetchSites } from '../sites/sites-api';
import type { SiteView } from '../sites/types';
import type { TenantUserView } from '../users/types';
import { fetchTenantUsers } from '../users/users-api';

// ORG-UX-1 (handoff §6.1 / §5) — the organization setup checklist, shared by Overview and
// App Home's "Your organization" card. The done-rules:
//   1. Complete the organization profile — country is saved.
//   2. Verify your email domain — domain verified.
//   3. Invite your team — more than one person (memberships, any status).
//   4. Add your sites — at least one site.
//   5. Approve a document template — an ACTIVE TENANT-owned template exists (a grandfathered
//      Aramo-default selection does not count — directive §8.9). GET /v1/document-templates
//      lists only the tenant's own rows; the tenant_id guard keeps that true defensively.
export type SetupItemKey = 'profile' | 'domain' | 'team' | 'sites' | 'template';

export interface SetupItem {
  readonly key: SetupItemKey;
  readonly label: string;
  readonly hint: string;
  readonly done: boolean;
  /** Where Finish / View goes. */
  readonly path: string;
}

export type SetupChecklistState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly SetupItem[]; readonly done: number; readonly total: number }
  | { readonly status: 'error' };

/** The slice of GET /v1/document-templates the checklist reads. */
export interface TemplateSummary {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly name: string;
  readonly status: string;
}

export const DOCUMENT_TEMPLATES_PATH = '/v1/document-templates';

export function fetchTenantTemplates(): Promise<readonly TemplateSummary[]> {
  return apiClient.get<TemplateSummary[]>(DOCUMENT_TEMPLATES_PATH);
}

/** Everything the checklist (and the Overview tiles) are computed from. */
export interface OrgSetupSources {
  readonly profile: TenantProfileView;
  readonly domain: DomainVerificationView;
  readonly users: readonly TenantUserView[];
  readonly sites: readonly SiteView[];
  readonly templates: readonly TemplateSummary[];
}

export interface OrgSetupFetchers {
  readonly profile: () => Promise<TenantProfileView>;
  readonly domain: () => Promise<DomainVerificationView>;
  readonly users: () => Promise<readonly TenantUserView[]>;
  readonly sites: () => Promise<readonly SiteView[]>;
  readonly templates: () => Promise<readonly TemplateSummary[]>;
}

export const DEFAULT_SETUP_FETCHERS: OrgSetupFetchers = {
  profile: fetchTenantProfile,
  domain: fetchDomainVerification,
  users: async () => (await fetchTenantUsers()).items,
  sites: async () => (await fetchSites()).items,
  templates: fetchTenantTemplates,
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The active, tenant-owned (approved) template, if any. */
export function approvedTenantTemplate(templates: readonly TemplateSummary[]): TemplateSummary | null {
  return templates.find((t) => t.status === 'ACTIVE' && t.tenant_id !== null) ?? null;
}

/** Pure: the five checklist items from the loaded sources (handoff §6.1). */
export function buildSetupChecklist(src: OrgSetupSources): readonly SetupItem[] {
  const countrySaved = (src.profile.country_code ?? '').trim() !== '';
  const domainName = src.domain.allowed_domain;
  const domainHint =
    src.domain.status === 'VERIFIED'
      ? `${domainName ?? 'Your domain'} verified`
      : src.domain.status === 'PENDING'
        ? 'Checking the DNS record'
        : domainName !== null
          ? `${domainName} not verified`
          : 'No domain verified yet';
  const approved = approvedTenantTemplate(src.templates);
  return [
    { key: 'profile', label: 'Complete the organization profile', done: countrySaved, hint: countrySaved ? 'Complete' : 'Country is missing', path: '/org/profile' },
    { key: 'domain', label: 'Verify your email domain', done: src.domain.status === 'VERIFIED', hint: domainHint, path: '/org/domain' },
    { key: 'team', label: 'Invite your team', done: src.users.length > 1, hint: `${plural(src.users.length, 'person', 'people')} in Aramo`, path: '/org/users' },
    { key: 'sites', label: 'Add your sites', done: src.sites.length > 0, hint: plural(src.sites.length, 'site', 'sites'), path: '/org/sites' },
    {
      key: 'template',
      label: 'Approve a document template',
      done: approved !== null,
      hint: approved !== null ? `${approved.name} is active` : 'No approved template yet',
      path: '/org/document-templates',
    },
  ];
}

export type OrgSetupDataState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly sources: OrgSetupSources }
  | { readonly status: 'error' };

/** Fetches the five sources in parallel on mount; `refresh` re-reads them. */
export function useOrgSetupData(fetchers: OrgSetupFetchers = DEFAULT_SETUP_FETCHERS): OrgSetupDataState & { readonly refresh: () => void } {
  const [state, setState] = useState<OrgSetupDataState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchers.profile(), fetchers.domain(), fetchers.users(), fetchers.sites(), fetchers.templates()])
      .then(([profile, domain, users, sites, templates]) => {
        if (!cancelled) setState({ status: 'ready', sources: { profile, domain, users, sites, templates } });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchers, attempt]);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, refresh };
}

export function checklistStateOf(data: OrgSetupDataState): SetupChecklistState {
  if (data.status !== 'ready') return data.status === 'loading' ? { status: 'loading' } : { status: 'error' };
  const items = buildSetupChecklist(data.sources);
  return { status: 'ready', items, done: items.filter((i) => i.done).length, total: items.length };
}

/** The setup checklist, read fresh each time the consuming page mounts. */
export function useSetupChecklist(fetchers: OrgSetupFetchers = DEFAULT_SETUP_FETCHERS): SetupChecklistState & { readonly refresh: () => void } {
  const data = useOrgSetupData(fetchers);
  return { ...checklistStateOf(data), refresh: data.refresh };
}
