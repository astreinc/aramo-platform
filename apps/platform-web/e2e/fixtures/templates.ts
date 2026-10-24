// PLATFORM-UX-1 H-1 — Template library + Template Studio fixtures: the prototype's
// VARS / TPLS0 / DOC_TYPES (doc/design-reference/platform-admin/platform/Template
// Studio.dc.html) ported into the REAL platform DTOs (document-templates-api.ts):
// templates with their versions (rtr-html-v1 field_schema, variables in the stored
// `<span data-field="key"></span>` form), the variable catalog, the allowed bindings
// and the document types. A stateful TemplateWorld answers the Studio's writes (save,
// preview, publish, withdraw) for the journeys. TEST-ONLY.

import type { Handler, MockOptions, Reply } from './mock-api';

const json = (body: unknown, status = 200): Reply => ({ status, body });

// ---- variables (prototype VARS) --------------------------------------------------

type VarRow = [key: string, label: string, group: string, type: string, sample: string, status: 'ACTIVE' | 'INACTIVE', binding: string | null];

export const VARS: readonly VarRow[] = [
  ['talent.first_name', 'First name', 'Talent', 'TEXT', 'Amina', 'ACTIVE', 'talent.firstName'],
  ['talent.full_name', 'Full name', 'Talent', 'TEXT', 'Amina Diallo', 'ACTIVE', 'talent.fullName'],
  ['talent.email', 'Email', 'Talent', 'TEXT', 'amina.diallo@mail.com', 'ACTIVE', 'talent.email'],
  ['requisition.title', 'Role title', 'Requisition', 'TEXT', 'Senior Platform Engineer', 'ACTIVE', 'requisition.title'],
  ['requisition.hiring_manager', 'Hiring manager', 'Requisition', 'TEXT', 'Jonas Weber', 'ACTIVE', 'requisition.hiringManager'],
  ['requisition.start_date', 'Start date', 'Requisition', 'DATE', '3 Nov 2026', 'ACTIVE', 'offer.startDate'],
  ['requisition.location', 'Work location', 'Requisition', 'TEXT', 'Hamburg, Germany', 'ACTIVE', 'requisition.location'],
  ['offer.base_salary', 'Base salary', 'Offer', 'CURRENCY', '€84,000', 'ACTIVE', 'offer.baseSalary'],
  ['offer.bonus_target', 'Bonus target', 'Offer', 'CURRENCY', '€8,400', 'ACTIVE', 'offer.bonusTarget'],
  ['offer.equity', 'Equity grant', 'Offer', 'TEXT', '1,200 share options', 'ACTIVE', null],
  ['offer.probation_months', 'Probation (months)', 'Offer', 'NUMBER', '6', 'ACTIVE', null],
  ['offer.hours_per_week', 'Hours per week', 'Offer', 'NUMBER', '40', 'INACTIVE', 'offer.hours'],
  ['offer.terms', 'Additional terms', 'Offer', 'MULTILINE_TEXT', 'Relocation support up to €5,000 is available on request.', 'ACTIVE', null],
  ['organization.legal_name', 'Legal name', 'Organization', 'TEXT', 'Northwind Logistics GmbH', 'ACTIVE', 'tenant.legalName'],
  ['organization.address', 'Registered address', 'Organization', 'MULTILINE_TEXT', 'Speicherstadt 12, 20457 Hamburg', 'ACTIVE', null],
  ['organization.signatory', 'Signatory name', 'Organization', 'TEXT', 'Jonas Weber', 'ACTIVE', null],
  ['organization.signatory_title', 'Signatory title', 'Organization', 'TEXT', 'Head of Engineering', 'ACTIVE', null],
  ['document.issue_date', 'Issue date', 'Document', 'DATE', '24 Oct 2026', 'ACTIVE', null],
  ['document.expiry_date', 'Response deadline', 'Document', 'DATE', '7 Nov 2026', 'ACTIVE', null],
];

const SAMPLE = new Map(VARS.map((v) => [v[0], v[4]]));

export function templateCatalog() {
  return {
    variables: VARS.map(([key, label, group, type, sample, status, binding], i) => ({
      id: `tv_${String(i + 1).padStart(2, '0')}`,
      key,
      label,
      group_label: group,
      data_type: type,
      products: ['ATS', 'SIGN'],
      ats_binding_key: binding,
      sample_value: sample,
      active: status === 'ACTIVE',
      created_at: '2026-01-15T09:00:00Z',
      updated_at: '2026-01-15T09:00:00Z',
    })),
  };
}

/** Every catalog key is bindable for these document types (the prototype has no per-type set). */
export function allowedBindings() {
  return { bindings: VARS.map(([key, label, group]) => ({ key, label, group })) };
}

// ---- document types (prototype DOC_TYPES) -----------------------------------------

export const DOC_TYPES = [
  { id: 'dty_offer', key: 'offer_letter', name: 'Offer letter', configurable: true },
  { id: 'dty_nda', key: 'nda', name: 'Non-disclosure agreement', configurable: true },
  { id: 'dty_contractor', key: 'contractor_agreement', name: 'Contractor agreement', configurable: true },
  { id: 'dty_interview', key: 'interview_confirmation', name: 'Interview confirmation', configurable: true },
  { id: 'dty_reference', key: 'reference_request', name: 'Reference request', configurable: true },
  { id: 'dty_rejection', key: 'rejection_letter', name: 'Rejection letter', configurable: true },
  { id: 'dty_tax', key: 'tax_form', name: 'Tax form', configurable: false },
  { id: 'dty_bg', key: 'background_check_consent', name: 'Background check consent', configurable: false },
];

// ---- content (prototype offerDraft / offerV3 / … builders) -------------------------

const v = (k: string) => `<span data-field="${k}"></span>`;
const UL = (a: string[]) => `<ul>${a.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const OL = (a: string[]) => `<ol>${a.map((i) => `<li>${i}</li>`).join('')}</ol>`;
const h2 = (t: string) => `<h2>${t}</h2>`;
const p = (t: string) => `<p>${t}</p>`;

export const OFFER_DRAFT = [
  h2('Offer of employment'),
  p(`Dear ${v('talent.first_name')},`),
  p(`We are pleased to offer you the position of <b>${v('requisition.title')}</b> at ${v('organization.legal_name')}, reporting to ${v('requisition.hiring_manager')}. Your start date will be ${v('requisition.start_date')}, based in ${v('requisition.location')}.`),
  h2('Compensation'),
  p(`Your annual base salary will be ${v('offer.base_salary')}, paid monthly. You will also receive a signing bonus of ${v('offer.signing_bonus')}.`),
  UL([`An annual performance bonus with a target of ${v('offer.bonus_target')}.`, `Equity: ${v('offer.equity')}, subject to the plan rules.`, `${v('offer.hours_per_week')} contracted hours per week.`]),
  h2('Benefits'),
  p('You will be enrolled in the benefits programme from your first day, including health cover, pension contributions and 25 days of paid leave per year.'),
  h2('Conditions'),
  OL(['Satisfactory references.', `Proof of your right to work in ${v('requisition.location')}.`, `Completion of a probation period of ${v('offer.probation_months')} months.`]),
  p(v('offer.terms')),
  h2('Confidentiality'),
  p(`During and after your employment you agree to keep confidential all non-public information about ${v('organization.legal_name')}, its clients and its talent.`),
  h2('Acceptance'),
  p(`Please sign this letter by ${v('document.expiry_date')} to accept the offer. If we have not received your signature by then, the offer will lapse.`),
  p(`Sincerely,<br>${v('organization.signatory')}<br>${v('organization.signatory_title')}`),
];
const OFFER_V3 = [
  h2('Offer of employment'),
  p(`Dear ${v('talent.first_name')},`),
  p(`We are pleased to offer you the position of <b>${v('requisition.title')}</b> at ${v('organization.legal_name')}, reporting to ${v('requisition.hiring_manager')}. Your start date will be ${v('requisition.start_date')}.`),
  h2('Compensation'),
  p(`Your annual base salary will be ${v('offer.base_salary')} per annum.`),
  UL([`An annual performance bonus with a target of ${v('offer.bonus_target')}.`, `Equity: ${v('offer.equity')}, subject to the plan rules.`]),
  h2('Benefits'),
  p('You will be enrolled in the benefits programme from your first day, including health cover and 25 days of paid leave per year.'),
  h2('Conditions'),
  OL(['Satisfactory references.', `Completion of a probation period of ${v('offer.probation_months')} months.`]),
  p(v('offer.terms')),
  h2('Acceptance'),
  p(`Please sign this letter by ${v('document.expiry_date')} to accept the offer.`),
  p(`Sincerely,<br>${v('organization.signatory')}`),
];
const OFFER_V2 = [
  h2('Offer of employment'),
  p(`Dear ${v('talent.first_name')},`),
  p(`We are pleased to offer you the position of ${v('requisition.title')} at ${v('organization.legal_name')}. Your start date will be ${v('requisition.start_date')}.`),
  h2('Compensation'),
  p(`Your annual base salary will be ${v('offer.base_salary')} per annum.`),
  p(v('offer.terms')),
  p(`Please sign this letter by ${v('document.expiry_date')}.`),
  p(`Sincerely,<br>${v('organization.signatory')}`),
];
const OFFER_V1 = [p(`Dear ${v('talent.first_name')},`), p(`We are pleased to offer you the position of ${v('requisition.title')} at ${v('organization.legal_name')}, with a base salary of ${v('offer.base_salary')}.`), p(`Sincerely,<br>${v('organization.signatory')}`)];
const NDA = [
  h2('Mutual non-disclosure agreement'),
  p(`This agreement is made between ${v('organization.legal_name')}, ${v('organization.address')}, and ${v('talent.full_name')}.`),
  h2('Confidential information'),
  p('Each party will keep confidential any non-public information shared during the interview process and will use it only to evaluate the potential engagement.'),
  h2('Term'),
  p(`These obligations last for two years from ${v('document.issue_date')}.`),
  p(`Signed for ${v('organization.legal_name')}:<br>${v('organization.signatory')}`),
];
const INTERVIEW = [p(`Hi ${v('talent.first_name')},`), p(`Your interview for ${v('requisition.title')} is confirmed. ${v('requisition.hiring_manager')} will meet you in ${v('requisition.location')}.`)];
const CONTRACTOR = [h2('Contractor agreement'), p(`${v('talent.full_name')} will provide services to ${v('organization.legal_name')} as an independent contractor from ${v('requisition.start_date')}.`), p(`Sincerely,<br>${v('organization.signatory')}`)];
const REF = [p('Dear referee,'), p(`${v('talent.full_name')} has applied for the role of ${v('requisition.title')} at ${v('organization.legal_name')} and named you as a referee.`)];

// ---- templates (prototype TPLS0) ---------------------------------------------------

type VStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
interface VerSeed {
  n: number;
  status: VStatus;
  date: string;
  title: string;
  blocks: string[];
}
interface TplSeed {
  id: string;
  name: string;
  type: string;
  desc: string;
  tags: string[];
  created: string;
  updated: string;
  draft: { title: string; blocks: string[] } | null;
  wd: { effective: string; notice: string } | null;
  versions: VerSeed[];
}

const day = (d: string) => `${d}T09:00:00.000Z`;

export const TEMPLATE_SEED: readonly TplSeed[] = [
  {
    id: 'dt_01J5OFFR',
    name: 'Offer letter',
    type: 'dty_offer',
    desc: 'Default offer letter used by ATS when an offer is approved.',
    tags: ['ATS', 'SIGN'],
    created: '2026-01-30',
    updated: '2026-10-24',
    draft: { title: 'Offer of employment', blocks: OFFER_DRAFT },
    wd: null,
    versions: [
      { n: 3, status: 'ACTIVE', date: '2026-09-02', title: 'Offer of employment', blocks: OFFER_V3 },
      { n: 2, status: 'RETIRED', date: '2026-05-14', title: 'Offer of employment', blocks: OFFER_V2 },
      { n: 1, status: 'RETIRED', date: '2026-01-30', title: 'Offer letter', blocks: OFFER_V1 },
    ],
  },
  {
    id: 'dt_01J5NDA0',
    name: 'Non-disclosure agreement',
    type: 'dty_nda',
    desc: 'Mutual NDA for talent before technical interviews.',
    tags: ['SIGN'],
    created: '2026-02-01',
    updated: '2026-08-09',
    draft: null,
    wd: null,
    versions: [
      { n: 2, status: 'ACTIVE', date: '2026-08-09', title: 'Mutual non-disclosure agreement', blocks: NDA },
      { n: 1, status: 'RETIRED', date: '2026-02-01', title: 'Non-disclosure agreement', blocks: NDA.slice(0, 4) },
    ],
  },
  {
    id: 'dt_01J5INTV',
    name: 'Interview confirmation',
    type: 'dty_interview',
    desc: 'Confirms interview time and location.',
    tags: ['ATS'],
    created: '2026-10-21',
    updated: '2026-10-21',
    draft: { title: 'Your interview', blocks: INTERVIEW },
    wd: null,
    versions: [],
  },
  {
    id: 'dt_01J5CONT',
    name: 'Contractor agreement',
    type: 'dty_contractor',
    desc: 'Independent contractor terms.',
    tags: ['ATS', 'SIGN'],
    created: '2025-11-12',
    updated: '2026-10-22',
    draft: null,
    wd: { effective: '2026-10-29', notice: '2026-10-22' },
    versions: [{ n: 4, status: 'ACTIVE', date: '2026-07-01', title: 'Contractor agreement', blocks: CONTRACTOR }],
  },
  {
    id: 'dt_01J5REFR',
    name: 'Reference request',
    type: 'dty_reference',
    desc: 'Asks a referee to respond about a talent.',
    tags: ['ATS'],
    created: '2026-04-03',
    updated: '2026-04-03',
    draft: null,
    wd: null,
    versions: [{ n: 1, status: 'ACTIVE', date: '2026-04-03', title: 'Reference request', blocks: REF }],
  },
];

const fs = (title: string, blocks: readonly string[]) => ({ render_schema_version: 'rtr-html-v1', title, html: blocks.join('') });

interface VersionDto {
  id: string;
  template_id: string;
  version_number: number;
  status: VStatus;
  render_schema_version: string;
  field_schema: { render_schema_version: string; title: string; html: string };
  activated_at: string | null;
  created_at: string;
  content_fingerprint: string | null;
  previewed_fingerprint: string | null;
  internal_notes: string | null;
}

function versionDto(t: TplSeed, s: VerSeed): VersionDto {
  return {
    id: `${t.id}_v${s.n}`,
    template_id: t.id,
    version_number: s.n,
    status: s.status,
    render_schema_version: 'rtr-html-v1',
    field_schema: fs(s.title, s.blocks),
    activated_at: s.status === 'DRAFT' ? null : day(s.date),
    created_at: day(s.date),
    content_fingerprint: `fp_${t.id}_${s.n}`,
    previewed_fingerprint: null,
    internal_notes: null,
  };
}

export function templateDetail(t: TplSeed) {
  const vers = t.versions.map((s) => versionDto(t, s));
  const next = Math.max(0, ...t.versions.map((x) => x.n)) + 1;
  const draft = t.draft !== null ? { ...versionDto(t, { n: next, status: 'DRAFT', date: t.updated, title: t.draft.title, blocks: t.draft.blocks }), created_at: day(t.updated) } : null;
  const cur = t.versions.find((x) => x.status === 'ACTIVE') ?? null;
  return {
    id: t.id,
    owner_scope: 'PLATFORM' as const,
    document_type_id: t.type,
    name: t.name,
    description: t.desc as string | null,
    template_kind: 'GENERATED',
    status: cur !== null ? 'ACTIVE' : 'DRAFT',
    products: [...t.tags],
    current_version: cur !== null ? { id: `${t.id}_v${cur.n}`, version_number: cur.n, status: 'ACTIVE' as const, activated_at: day(cur.date) } : null,
    draft_version_id: draft?.id ?? null,
    withdraw_notice_at: t.wd !== null ? day(t.wd.notice) : null,
    withdraw_effective_at: t.wd !== null ? `${t.wd.effective}T00:00:00.000Z` : null,
    created_at: day(t.created),
    updated_at: day(t.updated),
    versions: [...(draft !== null ? [draft] : []), ...vers],
  };
}

export function templateSummary(t: TplSeed) {
  const { versions: _v, ...rest } = templateDetail(t);
  return rest;
}

/** The server's sample render (POST …/preview): variables become `<span data-sample>` values. */
export function samplePreview(title: string, html: string) {
  const out = html.replace(/<span data-field="([^"]+)"><\/span>/g, (_m, k: string) => {
    const s = SAMPLE.get(k);
    // As the server (rtr-html-content.ts htmlWithSamples): a key with no sample is an empty data-sample span.
    return `<span data-sample="${k}">${(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
  });
  return {
    title,
    blocks: [],
    html: out,
    sample_values: VARS.map(([key, label, , , sample]) => ({ key, label, value: sample })),
  };
}

export const TEMPLATE_HANDLERS: [string, RegExp, Handler][] = [
  ['GET', /^\/platform\/document-templates$/, () => json({ templates: TEMPLATE_SEED.map(templateSummary) })],
  ['GET', /^\/platform\/document-templates\/document-types$/, () => json({ document_types: DOC_TYPES })],
  ['GET', /^\/platform\/document-templates\/versions\/[^/]+$/, ({ path }) => {
    const id = decodeURIComponent(path.split('/')[4]!);
    for (const t of TEMPLATE_SEED) {
      const hit = templateDetail(t).versions.find((x) => x.id === id);
      if (hit) return json(hit);
    }
    return undefined;
  }],
  ['GET', /^\/platform\/document-templates\/[^/]+\/allowed-bindings$/, () => json(allowedBindings())],
  ['PATCH', /^\/platform\/document-templates\/versions\/[^/]+$/, ({ path, body }) => {
    const id = decodeURIComponent(path.split('/')[4]!);
    for (const t of TEMPLATE_SEED) {
      const hit = templateDetail(t).versions.find((x) => x.id === id);
      if (hit) return json({ ...hit, field_schema: (body as { field_schema?: unknown }).field_schema ?? hit.field_schema, content_fingerprint: `${hit.content_fingerprint ?? ''}_saved` });
    }
    return undefined;
  }],
  ['POST', /^\/platform\/document-templates\/versions\/[^/]+\/preview$/, ({ path }) => {
    const id = decodeURIComponent(path.split('/')[4]!);
    for (const t of TEMPLATE_SEED) {
      const hit = templateDetail(t).versions.find((x) => x.id === id);
      if (hit) return json(samplePreview(hit.field_schema.title, hit.field_schema.html));
    }
    return undefined;
  }],
  ['GET', /^\/platform\/document-templates\/[^/]+$/, ({ path }) => {
    const t = TEMPLATE_SEED.find((x) => x.id === decodeURIComponent(path.split('/')[3]!));
    return t ? json(templateDetail(t)) : undefined;
  }],
];

/**
 * The Studio's variable catalog is the Template Studio file's VARS (19 keys), not
 * the Template variables page's sample (Platform Admin.dc.html, rest.ts): Studio
 * states answer GET /platform/template-variables from it.
 */
export const STUDIO_CATALOG = { path: /^\/platform\/template-variables$/, reply: () => json(templateCatalog()) };

export function studioMock(extra: MockOptions = {}): MockOptions {
  return { ...extra, overrides: [...(extra.overrides ?? []), STUDIO_CATALOG] };
}

// ---- stateful world (journeys J8, J11) ---------------------------------------------

type Detail = ReturnType<typeof templateDetail>;
type Version = Detail['versions'][number];

const NOW = Date.parse('2026-10-24T15:00:00Z');

export class TemplateWorld {
  readonly log: string[] = [];
  private readonly t: Record<string, Detail> = {};
  private seq = 0;

  constructor(seed: readonly TplSeed[] = TEMPLATE_SEED) {
    for (const s of seed) this.t[s.id] = templateDetail(s);
  }

  detail(id: string): Detail | undefined {
    return this.t[id];
  }

  private versionById(id: string): { d: Detail; v: Version } | null {
    for (const d of Object.values(this.t)) {
      const v = d.versions.find((x) => x.id === id);
      if (v) return { d, v };
    }
    return null;
  }

  mock(extra: MockOptions = {}): MockOptions {
    const w = this;
    const summary = (d: Detail) => {
      const { versions: _v, ...rest } = d;
      return rest;
    };
    return {
      ...extra,
      overrides: [
        ...(extra.overrides ?? []),
        STUDIO_CATALOG,
        { path: /^\/platform\/document-templates$/, reply: () => json({ templates: Object.values(w.t).map(summary) }) },
        {
          method: 'POST',
          path: /^\/platform\/document-templates$/,
          reply: ({ body }) => {
            const b = body as { document_type_id: string; name: string; description: string | null; products: string[] };
            w.seq += 1;
            const id = `dt_01JBNEW${w.seq}`;
            const at = new Date(NOW).toISOString();
            w.t[id] = { id, owner_scope: 'PLATFORM', document_type_id: b.document_type_id, name: b.name, description: b.description, template_kind: 'GENERATED', status: 'DRAFT', products: b.products, current_version: null, draft_version_id: null, withdraw_notice_at: null, withdraw_effective_at: null, created_at: at, updated_at: at, versions: [] };
            w.log.push(`create ${b.name} type=${b.document_type_id}`);
            return json(summary(w.t[id]!), 201);
          },
        },
        {
          path: /^\/platform\/document-templates\/(?!versions\/|document-types$)[^/]+$/,
          reply: ({ path }) => {
            const d = w.t[decodeURIComponent(path.split('/')[3]!)];
            return d ? json(d) : undefined;
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/document-templates\/[^/]+\/versions$/,
          reply: ({ path, body }) => {
            const d = w.t[decodeURIComponent(path.split('/')[3]!)];
            if (!d) return undefined;
            const b = (body ?? {}) as { field_schema?: unknown };
            const n = Math.max(0, ...d.versions.map((x) => x.version_number)) + 1;
            const v: Version = { id: `${d.id}_v${n}`, template_id: d.id, version_number: n, status: 'DRAFT', render_schema_version: 'rtr-html-v1', field_schema: (b.field_schema ?? fs('', [])) as Version['field_schema'], activated_at: null, created_at: new Date(NOW).toISOString(), content_fingerprint: `fp_${d.id}_${n}_0`, previewed_fingerprint: null, internal_notes: null };
            d.versions.unshift(v);
            d.draft_version_id = v.id;
            w.log.push(`draft ${d.id} v${n}`);
            return json(v, 201);
          },
        },
        {
          method: 'PATCH',
          path: /^\/platform\/document-templates\/versions\/[^/]+$/,
          reply: ({ path, body }) => {
            const hit = w.versionById(decodeURIComponent(path.split('/')[4]!));
            if (!hit) return undefined;
            const b = body as { field_schema?: unknown };
            if (b.field_schema !== undefined) hit.v.field_schema = b.field_schema as Version['field_schema'];
            w.seq += 1;
            hit.v.content_fingerprint = `fp_${hit.v.id}_${w.seq}`;
            w.log.push(`save ${hit.v.id}`);
            return json(hit.v);
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/document-templates\/versions\/[^/]+\/preview$/,
          reply: ({ path }) => {
            const hit = w.versionById(decodeURIComponent(path.split('/')[4]!));
            if (!hit) return undefined;
            hit.v.previewed_fingerprint = hit.v.content_fingerprint;
            const c = hit.v.field_schema as { title: string; html: string };
            w.log.push(`preview ${hit.v.id}`);
            return json(samplePreview(c.title, c.html));
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/document-templates\/versions\/[^/]+\/publish$/,
          reply: ({ path }) => {
            const hit = w.versionById(decodeURIComponent(path.split('/')[4]!));
            if (!hit) return undefined;
            const at = new Date(NOW).toISOString();
            for (const x of hit.d.versions) if (x.status === 'ACTIVE') x.status = 'RETIRED';
            hit.v.status = 'ACTIVE';
            hit.v.activated_at = at;
            hit.d.status = 'ACTIVE';
            hit.d.current_version = { id: hit.v.id, version_number: hit.v.version_number, status: 'ACTIVE', activated_at: at };
            hit.d.draft_version_id = null;
            w.log.push(`publish ${hit.v.id}`);
            return json(hit.v);
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/document-templates\/[^/]+\/withdraw$/,
          reply: ({ path, body }) => {
            const d = w.t[decodeURIComponent(path.split('/')[3]!)];
            if (!d) return undefined;
            const b = body as { notice_days: number; reason: string | null };
            d.withdraw_notice_at = new Date(NOW).toISOString();
            d.withdraw_effective_at = new Date(NOW + b.notice_days * 864e5).toISOString();
            w.log.push(`withdraw ${d.id} days=${b.notice_days} reason=${b.reason ?? ''}`);
            const { versions: _v, ...rest } = d;
            return json(rest);
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/document-templates\/[^/]+\/withdraw\/cancel$/,
          reply: ({ path }) => {
            const d = w.t[decodeURIComponent(path.split('/')[3]!)];
            if (!d) return undefined;
            d.withdraw_notice_at = null;
            d.withdraw_effective_at = null;
            w.log.push(`cancel-withdraw ${d.id}`);
            const { versions: _v, ...rest } = d;
            return json(rest);
          },
        },
      ],
    };
  }
}

/** GET one template, patched (e.g. a previewed or an empty draft) — a Studio-state override. */
export function detailOverride(id: string, patch: (d: Detail) => Detail) {
  const t = TEMPLATE_SEED.find((x) => x.id === id)!;
  return { path: new RegExp(`^/platform/document-templates/${id}$`), reply: () => json(patch(templateDetail(t))) };
}

/** The draft was previewed after its last save (previewed fingerprint = content fingerprint). */
export const previewedDraft = (d: Detail): Detail => ({ ...d, versions: d.versions.map((v) => (v.status === 'DRAFT' ? { ...v, previewed_fingerprint: v.content_fingerprint } : v)) });

/** The draft has no content yet (the "Start this template" state). */
export const emptyDraft = (d: Detail): Detail => ({
  ...d,
  versions: d.versions.map((v) => (v.status === 'DRAFT' ? { ...v, field_schema: { ...v.field_schema, html: '' } } : v)),
});
