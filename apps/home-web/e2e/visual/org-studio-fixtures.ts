// TEMPLATE-STUDIO-1 — the mocked tenant API behind the Org Template Studio + Template
// gallery visual suite (org-template-studio.spec.ts). Every /auth and /v1 call is answered
// by page.route: no backend, no Cognito. The variable catalog is the REAL RTR binding
// catalog's keys, labels, groups and samples (apps/api/src/rtr/rtr-template-content.ts
// RTR_BINDING_CATALOG), so the Outline and Variables panels show what production shows.

import type { Page, Route } from '@playwright/test';

/** The suite's frozen clock (dates in the gallery / version lists never move). */
export const NOW_ISO = '2026-10-27T12:00:00.000Z';

const RTR = 'd0c50005-0000-7000-8000-000000000001';
const LOGO = '<div data-asset="tenant.logo"></div>';

const field = (k: string): string => `<span data-field="${k}"></span>`;
const BODY =
  `<h2>Authorization to represent</h2><p>I, ${field('talent.full_name')}, authorize ${field('recruiting_company.name')} to represent me to ` +
  `${field('client.name')} for the ${field('requisition.title')} requisition (${field('requisition.reference')}). This authorization covers ` +
  'this one client and this one requisition only, and it stays in place until the requisition closes.</p>' +
  `<h2>About the role</h2><p>${field('requisition.description')}</p>` +
  `<p>Your recruiter: ${field('recruiter.display_name')}, ${field('recruiting_company.name')}</p>`;

interface CatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly sample: string;
}

/** RTR_BINDING_CATALOG (apps/api/src/rtr/rtr-template-content.ts) — the RTR's bindable set. */
const CATALOG: readonly CatalogEntry[] = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent', sample: 'Ravi Shankar' },
  { key: 'talent.desired_pay_rate', label: 'Desired pay rate', group: 'Talent', sample: '$70/hr' },
  { key: 'client.name', label: 'Client name', group: 'Client', sample: 'Mindlance' },
  { key: 'requisition.title', label: 'Requisition title', group: 'Requisition', sample: 'Business Analyst - Multi-Family' },
  { key: 'requisition.reference', label: 'Requisition reference', group: 'Requisition', sample: 'REQ-1001' },
  { key: 'requisition.description', label: 'Job description', group: 'Requisition', sample: 'Analyze business requirements for multi-family housing programs.' },
  { key: 'recruiting_company.name', label: 'Recruiting company', group: 'Recruiting organization', sample: 'Astre Consulting' },
  { key: 'recruiter.display_name', label: 'Recruiter name', group: 'Recruiter', sample: 'Deepika Rao' },
  { key: 'organization.name', label: 'Organization name', group: 'Organization', sample: 'Astre Consulting' },
];
const SAMPLE = new Map(CATALOG.map((c) => [c.key, c.sample]));
const sampled = (html: string): string =>
  html.replace(/<span data-field="([^"]+)"><\/span>/g, (_m, k: string) => `<span data-sample="${k}">${SAMPLE.get(k) ?? k}</span>`);
const SAMPLE_VALUES = CATALOG.map((c) => ({ key: c.key, label: c.label, value: c.sample }));
const BINDINGS = CATALOG.map((c) => ({ key: c.key, label: c.label, group: c.group, data_type: c.key === 'requisition.description' ? 'MULTILINE_TEXT' : 'TEXT', sample_value: c.sample, active: true }));

const tpl = (id: string, name: string, status: string, current: string | null) => ({
  id, tenant_id: 't', document_type_id: RTR, client_id: null, name, description: null, template_kind: 'GENERATED', status,
  current_version_id: current, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z',
});
const ver = (tid: string, id: string, n: number, status: string, html: string, logo: { asset_id: string; mime: string } | null = null) => ({
  id, tenant_id: 't', template_id: tid, version_number: n, status, render_schema_version: 'rtr-html-v1',
  field_schema: { render_schema_version: 'rtr-html-v1', title: 'Right to Represent', html }, binding_schema: null, created_by: 'u',
  created_at: `2026-10-0${n}T09:00:00.000Z`, activated_at: status === 'DRAFT' ? null : `2026-10-0${n}T10:00:00.000Z`,
  activated_by: status === 'DRAFT' ? null : 'u-approver', retired_at: null, content_fingerprint: 'fp', previewed_fingerprint: null, logo,
});
export const libraryItem = (over: Record<string, unknown>) => ({
  id: 'x', owner_scope: 'TENANT', document_type_id: RTR, name: 'T', description: null, template_kind: 'GENERATED', status: 'ACTIVE',
  client_id: null, current_version_id: 'v', current_version_number: 1, updated_at: '2026-10-15T10:00:00.000Z', products: null,
  withdraw_effective_at: null, configurable: true, ...over,
});
export const ARAMO_DEFAULT = libraryItem({
  id: 'def-rtr', owner_scope: 'PLATFORM', name: 'Aramo Right to Represent', products: ['ATS'], current_version_id: 'pv3', current_version_number: 3,
});
const DOC_TYPES = [{ id: RTR, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true }];
const LOGO_REF = { asset_id: 'a1', mime: 'image/png' };

const TEMPLATES: Record<string, { t: unknown; v: unknown[] }> = {
  // the adopted draft (never approved)
  'tpl-new': { t: tpl('tpl-new', 'Aramo Right to Represent', 'DRAFT', null), v: [ver('tpl-new', 'n1', 1, 'DRAFT', LOGO + BODY, LOGO_REF)] },
  // approved v2, no draft → Create new version
  'tpl-2': { t: tpl('tpl-2', 'Astre Right to Represent', 'ACTIVE', 'v2'), v: [ver('tpl-2', 'v2', 2, 'ACTIVE', BODY), ver('tpl-2', 'v1', 1, 'RETIRED', BODY)] },
  // approved v2 with an open draft v3 → Approve & activate
  'tpl-1': {
    t: tpl('tpl-1', 'Astre Right to Represent', 'ACTIVE', 'v2'),
    v: [ver('tpl-1', 'd3', 3, 'DRAFT', LOGO + BODY, LOGO_REF), ver('tpl-1', 'v2', 2, 'ACTIVE', BODY), ver('tpl-1', 'v1', 1, 'RETIRED', BODY)],
  },
};

/** A 1×1 PNG (the tenant logo bytes). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const MANAGER_SCOPES = ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'];
export const AUTHOR_SCOPES = ['auth:session:read', 'document_template:read', 'document_template:author'];

export interface OrgWorld {
  libraryItems: unknown[];
  scopes: readonly string[];
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Answers every tenant API call the gallery and the Org Studio make; `world` is read per request. */
export async function mockOrgApi(page: Page, world: OrgWorld): Promise<void> {
  await page.route(
    (url) => /^\/(auth|v1)\//.test(url.pathname),
    (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const m = req.method();
      if (p.startsWith('/auth/org/session')) return json(route, { sub: 'u1', consumer_type: 'org', tenant_id: 't', scopes: world.scopes, iat: 0, exp: 4102444800 });
      if (p === '/v1/me/products') {
        return json(route, { tenant_id: 't', products: [{ key: 'org', subscribed: true, authorized: true, available: true, entry_path: '/org/', reason: null, org_access: 'admin' }] });
      }
      if (p.startsWith('/v1/me')) return json(route, { user: { display_name: 'Olivia Owner', email: 'olivia@astre.test' }, roles: [], tenant: { display_name: 'Astre Consulting', status: 'ACTIVE' } });
      if (p === '/v1/document-templates/library') return json(route, { items: world.libraryItems, document_types: DOC_TYPES });
      if (p === '/v1/document-templates/library/def-rtr/preview') {
        return json(route, {
          title: 'Right to Represent', blocks: [], html: sampled(BODY), sample_values: SAMPLE_VALUES, template_id: 'def-rtr', version_id: 'pv3',
          version_number: 3, updated_at: '2026-10-15T10:00:00.000Z', letterhead: { organization_name: 'Astre Consulting', logo_available: true },
        });
      }
      if (p === '/v1/document-templates/selections') return json(route, { items: [] });
      if (p === '/v1/document-templates/notices') return json(route, { notices: [] });
      if (p === '/v1/document-templates/adopt' && m === 'POST') {
        const n = TEMPLATES['tpl-new'];
        return json(route, { template: n?.t, version: n?.v[0] });
      }
      let mm = /^\/v1\/document-templates\/([^/]+)$/.exec(p);
      if (mm?.[1] !== undefined && TEMPLATES[mm[1]] !== undefined) return json(route, TEMPLATES[mm[1]]?.t);
      mm = /^\/v1\/document-templates\/([^/]+)\/versions$/.exec(p);
      if (mm?.[1] !== undefined && TEMPLATES[mm[1]] !== undefined) return json(route, TEMPLATES[mm[1]]?.v);
      if (/^\/v1\/document-templates\/[^/]+\/allowed-bindings$/.test(p)) {
        return json(route, { bindings: BINDINGS, tenant_logo: { available: true, tenant_name: 'Astre Consulting' } });
      }
      if (/^\/v1\/document-templates\/versions\/[^/]+\/preview$/.test(p)) {
        return json(route, { title: 'Right to Represent', html: LOGO + sampled(BODY), sample_values: SAMPLE_VALUES, logo: { asset_id: 'a1' } });
      }
      if (p.endsWith('/logo/content')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      if (p.startsWith('/v1/users') || p.includes('directory')) return json(route, { items: [{ user_id: 'u-approver', display_name: 'Olivia Owner' }] });
      return json(route, {});
    },
  );
}
