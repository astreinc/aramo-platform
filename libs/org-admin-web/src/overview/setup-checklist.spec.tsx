import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { domain, profile, site, user } from './setup.fixture';
import { buildSetupChecklist, useSetupChecklist, type OrgSetupFetchers, type OrgSetupSources, type TemplateSummary } from './setup-checklist';

// ORG-UX-1 §8.9 / handoff §6.1 — the setup checklist done-rules.

const tpl = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({ id: 'tp1', tenant_id: 't1', name: 'Standard Right to Represent', status: 'ACTIVE', ...over });

function sources(over: Partial<OrgSetupSources> = {}): OrgSetupSources {
  return { profile: profile(), domain: domain(), users: [user('u1')], sites: [], templates: [], ...over };
}
const item = (src: OrgSetupSources, key: string) => buildSetupChecklist(src).find((i) => i.key === key);

describe('buildSetupChecklist — done rules', () => {
  it('lists the five items in order with their section paths', () => {
    const items = buildSetupChecklist(sources());
    expect(items.map((i) => [i.key, i.path])).toEqual([
      ['profile', '/org/profile'],
      ['domain', '/org/domain'],
      ['team', '/org/users'],
      ['sites', '/org/sites'],
      ['template', '/org/document-templates'],
    ]);
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it('profile is done only when a country is saved', () => {
    expect(item(sources({ profile: profile({ legal_name: 'Acme', city: 'X' }) }), 'profile')).toMatchObject({ done: false, hint: 'Country is missing' });
    expect(item(sources({ profile: profile({ country_code: 'US' }) }), 'profile')).toMatchObject({ done: true, hint: 'Complete' });
  });

  it('domain is done only when VERIFIED (PENDING is not)', () => {
    expect(item(sources({ domain: domain({ status: 'PENDING' }) }), 'domain')).toMatchObject({ done: false, hint: 'Checking the DNS record' });
    expect(item(sources(), 'domain')).toMatchObject({ done: false, hint: 'acme.test not verified' });
    expect(item(sources({ domain: domain({ status: 'VERIFIED' }) }), 'domain')).toMatchObject({ done: true, hint: 'acme.test verified' });
  });

  it('team is done with more than one person (any membership status)', () => {
    expect(item(sources(), 'team')).toMatchObject({ done: false, hint: '1 person in Aramo' });
    expect(item(sources({ users: [user('u1'), user('u2', { invite_status: 'INVITED' })] }), 'team')).toMatchObject({ done: true, hint: '2 people in Aramo' });
  });

  it('sites is done with at least one site', () => {
    expect(item(sources(), 'sites')).toMatchObject({ done: false, hint: '0 sites' });
    expect(item(sources({ sites: [site('s1')] }), 'sites')).toMatchObject({ done: true, hint: '1 site' });
  });

  it('template is done only for an ACTIVE tenant-owned template', () => {
    expect(item(sources({ templates: [tpl({ status: 'DRAFT' })] }), 'template')?.done).toBe(false);
    expect(item(sources({ templates: [tpl({ status: 'RETIRED' })] }), 'template')?.done).toBe(false);
    expect(item(sources({ templates: [tpl()] }), 'template')).toMatchObject({ done: true, hint: 'Standard Right to Represent is active' });
  });

  it('a legacy Aramo-default (platform-owned) template does NOT count', () => {
    expect(item(sources({ templates: [tpl({ tenant_id: null })] }), 'template')).toMatchObject({ done: false, hint: 'No approved template yet' });
  });
});

function Probe({ fetchers }: { readonly fetchers: OrgSetupFetchers }) {
  const s = useSetupChecklist(fetchers);
  return <p data-testid="probe">{s.status === 'ready' ? `${s.done}/${s.total}` : s.status}</p>;
}

describe('useSetupChecklist', () => {
  const fetchers = (over: Partial<OrgSetupFetchers> = {}): OrgSetupFetchers => ({
    profile: () => Promise.resolve(profile({ country_code: 'US' })),
    domain: () => Promise.resolve(domain({ status: 'VERIFIED' })),
    users: () => Promise.resolve([user('a'), user('b')]),
    sites: () => Promise.resolve([site('s')]),
    templates: () => Promise.resolve([tpl({ tenant_id: null })]),
    ...over,
  });

  it('fetches all five sources and counts done items', async () => {
    const f = fetchers();
    const spies = Object.fromEntries(Object.entries(f).map(([k, fn]) => [k, vi.fn(fn)])) as unknown as OrgSetupFetchers;
    render(<Probe fetchers={spies} />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('4/5'));
    for (const fn of Object.values(spies)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports error when a source fails (never a guessed state)', async () => {
    render(<Probe fetchers={fetchers({ sites: () => Promise.reject(new Error('x')) })} />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('error'));
  });
});
