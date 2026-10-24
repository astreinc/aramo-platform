// PLATFORM-UX-1 H-1 — fixtures for Sign Personal, Skills, Matching, Template
// variables and Platform admins: the prototype's PA / SKILLS / QUEUE / PROPS / POL
// / VARS data ported into the REAL API DTOs. Where the real enum differs from the
// prototype's sample enum, the real value is used and the visual region is a
// typed divergence (DIVERGENCES.md). TEST-ONLY.

import type { Handler } from './mock-api';

const json = (body: unknown, status = 200) => ({ status, body });

// ---- Sign Personal (prototype PA) ---------------------------------------------

interface PaSeed {
  id: string;
  tenant: string;
  email: string;
  state: 'review' | 'restricted' | 'clear' | 'closed';
  reason: string;
  points: number;
  phone: boolean;
  net: [string, string];
  until: string | null;
  signedUp: string;
  owed: boolean;
  signals: [string, number][];
  reports: { id: string; at: string; cat: string; note: string; outcome: string; reasonTxt?: string }[];
}

const PA: PaSeed[] = [
  { id: 'pa_01HV2', tenant: 'Odile Marchand', email: 'odile.marchand@proton.me', state: 'review', reason: 'Signals passed the review threshold', points: 42, phone: true, net: ['Lyon, FR', 'AS3215'], until: null, signedUp: '2026-10-19T18:22:00Z', owed: true, signals: [['burst_send_first_day', 18], ['recipient_report', 12], ['shared_network_signups', 8], ['disposable_recipients', 4]], reports: [{ id: 'rp_9x1', at: '2026-10-21T09:10:00Z', cat: 'Unwanted envelope', note: 'Recipient does not know the sender.', outcome: 'OPEN' }] },
  { id: 'pa_01HV7', tenant: 'Amara Nwosu', email: 'amara.nwosu@gmail.com', state: 'review', reason: 'Phone step not completed', points: 24, phone: false, net: ['Lagos, NG', 'AS29465'], until: null, signedUp: '2026-10-22T07:41:00Z', owed: true, signals: [['phone_unverified', 10], ['new_device', 6], ['anonymising_network', 8]], reports: [] },
  { id: 'pa_01HQ3', tenant: 'J. Whitcombe', email: 'jwhitcombe@outlook.com', state: 'restricted', reason: 'Confirmed report: impersonation', points: 58, phone: true, net: ['Leeds, GB', 'AS5089'], until: '2026-11-07T00:00:00Z', signedUp: '2026-09-30T11:05:00Z', owed: true, signals: [['impersonation_terms', 20], ['recipient_report', 12], ['recipient_report', 12], ['template_fanout', 14]], reports: [{ id: 'rp_7k2', at: '2026-10-03T14:00:00Z', cat: 'Impersonation', note: 'Envelope used a bank name in its subject.', outcome: 'CONFIRMED', reasonTxt: 'Subject and sender name match the reported pattern.' }, { id: 'rp_7k9', at: '2026-10-12T10:20:00Z', cat: 'Unwanted envelope', note: '', outcome: 'OPEN' }] },
  { id: 'pa_01HM8', tenant: 'Pilar Ochoa', email: 'pilar.ochoa@gmail.com', state: 'clear', reason: 'Cleared after review', points: 6, phone: true, net: ['Madrid, ES', 'AS3352'], until: null, signedUp: '2026-10-20T16:02:00Z', owed: false, signals: [['new_device', 6]], reports: [] },
  { id: 'pa_01GZ1', tenant: 'Rafael Duarte', email: 'rduarte.docs@mail.com', state: 'closed', reason: 'Closed: repeated confirmed reports', points: 71, phone: true, net: ['Porto, PT', 'AS12353'], until: null, signedUp: '2026-08-14T09:00:00Z', owed: false, signals: [['template_fanout', 14], ['recipient_report', 12], ['recipient_report', 12], ['impersonation_terms', 20], ['name_mismatch', 13]], reports: [{ id: 'rp_5a0', at: '2026-08-20T08:00:00Z', cat: 'Fraud attempt', note: 'Asked recipient for bank details.', outcome: 'CONFIRMED', reasonTxt: 'Verified with recipient.' }, { id: 'rp_5a4', at: '2026-08-21T12:00:00Z', cat: 'Unwanted envelope', note: '', outcome: 'FALSE_REPORT', reasonTxt: 'Recipient had requested the document.' }] },
];

export function personalReview() {
  return {
    phone_verification_available: true,
    items: PA.map((a) => ({
      tenant_id: a.id,
      tenant_name: a.tenant,
      owner_email: a.email,
      state: a.state,
      reason: a.reason,
      review_pending: a.owed,
      risk_points: a.points,
      signals: a.signals.map(([key, points]) => ({ key, points })),
      phone_verified_at: a.phone ? a.signedUp : null,
      restricted_until: a.until,
      report_count: a.reports.length,
      step_up_required: !a.phone,
      step_up_cleared_by: null,
      geo: { country: a.net[0], looked_up_at: a.signedUp, db_version: a.net[1] },
      created_at: a.signedUp,
      updated_at: a.signedUp,
    })),
  };
}

export function personalReports(id: string) {
  const a = PA.find((x) => x.id === id);
  return {
    items: (a?.reports ?? []).map((r) => ({
      id: r.id,
      envelope_id: `env_${r.id}`,
      reason: r.cat,
      note: r.note || null,
      reporter_domain: 'example.com',
      weight: 12,
      triggered_restriction: false,
      outcome: r.outcome,
      outcome_reason: r.reasonTxt ?? null,
      decided_at: r.outcome === 'OPEN' ? null : r.at,
      created_at: r.at,
    })),
  };
}

export const PILOT_CODE = { code: 'PILOT-7KQ2-M9XD', email: 'lena.fischer@posteo.de', expires_at: '2026-11-07T15:00:00Z' };

// ---- Skills (prototype SKILLS / QUEUE / PROPS) --------------------------------

const ALIAS_MAP: Record<string, string> = { SYNONYM: 'COMMON_NAME', ABBREVIATION: 'ABBREVIATION', MISSPELLING: 'SPELLING_VARIANT', COLLOQUIAL: 'COMMON_NAME', TRANSLATION: 'COMMON_NAME' };
const SOURCE_MAP: Record<string, string> = { CURATED: 'ADMIN_CURATED', AI_PROPOSAL: 'AI_RECOMMENDED', IMPORT: 'IMPORTED_TAXONOMY', TENANT_SIGNAL: 'ADMIN_CURATED' };
const SYMMETRIC = new Set(['RELATED_TO', 'COMPATIBLE_WITH']);

interface SkillSeed {
  id: string;
  name: string;
  active: boolean;
  updated: string;
  aliases: [string, string][];
  versions: [string, string, string][];
  rels: [string, string, string, string][];
}

export const SKILLS: SkillSeed[] = [
  { id: 'sk_01J1KUBE', name: 'Kubernetes', active: true, updated: '2026-10-12', aliases: [['K8s', 'ABBREVIATION'], ['Kube', 'COLLOQUIAL']], versions: [['1.29', 'kubernetes', 'CURRENT'], ['1.24', 'kubernetes', 'LEGACY']], rels: [['sk_01J1DOCK', 'REQUIRES', 'CURATED', 'taxonomy-v4'], ['sk_01J1TERR', 'RELATED_TO', 'AI_PROPOSAL', 'pp_01H8']] },
  { id: 'sk_01J1DOCK', name: 'Docker', active: true, updated: '2026-09-02', aliases: [['Docker containers', 'SYNONYM']], versions: [], rels: [] },
  { id: 'sk_01J1PYTH', name: 'Python', active: true, updated: '2026-10-01', aliases: [['Py', 'ABBREVIATION'], ['Pyhton', 'MISSPELLING']], versions: [['3.12', 'python', 'CURRENT'], ['2.7', 'python', 'LEGACY']], rels: [] },
  { id: 'sk_01J1DATA', name: 'Data analysis', active: true, updated: '2026-08-21', aliases: [], versions: [], rels: [] },
  { id: 'sk_01J1TERR', name: 'Terraform', active: true, updated: '2026-07-30', aliases: [['TF', 'ABBREVIATION']], versions: [], rels: [] },
  { id: 'sk_01J1PEDN', name: 'Pediatric nursing', active: true, updated: '2026-09-18', aliases: [['Paediatric nursing', 'SYNONYM']], versions: [], rels: [] },
  { id: 'sk_01J1FORK', name: 'Forklift operation', active: true, updated: '2026-06-11', aliases: [], versions: [], rels: [] },
  { id: 'sk_01J1REAC', name: 'React', active: true, updated: '2026-10-20', aliases: [['React.js', 'SYNONYM']], versions: [['19', 'react', 'CURRENT']], rels: [] },
  { id: 'sk_01J1PAYR', name: 'Payroll processing', active: false, updated: '2026-04-02', aliases: [], versions: [], rels: [] },
];

const skillDto = (s: SkillSeed) => ({
  id: s.id,
  canonical_name: s.name,
  normalized_name: s.name.toLowerCase(),
  description: null,
  status: s.active ? 'active' : 'inactive',
  merged_into_skill_id: null,
  created_at: '2026-01-05T09:00:00Z',
  updated_at: `${s.updated}T09:00:00Z`,
});

const QUEUE = [
  ['k8s admin', 214, 9],
  ['reactjs', 180, 11],
  ['RN pediatrics', 88, 4],
  ['reach truck', 61, 3],
  ['pyspark', 57, 6],
  ['infra as code', 22, 5],
  ['gusto payroll', 9, 2],
] as const;

const PROPS = [
  { id: 'pp_01H8', type: 'ALIAS', status: 'PENDING', at: '2026-10-22', payload: { alias: 'k8s admin', skill_id: 'sk_01J1KUBE', alias_type: 'COMMON_NAME' } },
  { id: 'pp_01H9', type: 'RELATIONSHIP', status: 'PENDING', at: '2026-10-21', payload: { source_skill_id: 'sk_01J1PYTH', target_skill_id: 'sk_01J1DATA', relationship_type: 'RELATED_TO', source: 'AI_RECOMMENDED' } },
  { id: 'pp_01HA', type: 'ALIAS', status: 'PENDING', at: '2026-10-20', payload: { alias: 'reactjs', skill_id: 'sk_01J1REAC', alias_type: 'COMMON_NAME' } },
  { id: 'pp_01G2', type: 'RELATIONSHIP', status: 'ACCEPTED', at: '2026-09-30', payload: { source_skill_id: 'sk_01J1KUBE', target_skill_id: 'sk_01J1TERR', relationship_type: 'RELATED_TO', source: 'AI_RECOMMENDED' } },
  { id: 'pp_01G0', type: 'ALIAS', status: 'REJECTED', at: '2026-09-12', payload: { alias: 'snake', skill_id: 'sk_01J1PYTH', alias_type: 'COMMON_NAME' }, reason: 'Too ambiguous to map.' },
];

const proposalDto = (p: (typeof PROPS)[number]) => ({
  id: p.id,
  proposal_type: p.type,
  source: 'AI_RECOMMENDED',
  status: p.status,
  payload: p.payload,
  proposed_by: null,
  proposed_at: `${p.at}T09:00:00Z`,
  decided_by: p.status === 'PENDING' ? null : 'op_7f3a91c2e48b',
  decided_at: p.status === 'PENDING' ? null : `${p.at}T12:00:00Z`,
  decision_reason: 'reason' in p ? p.reason : null,
  applied_entity_id: null,
});

/** The proposals, optionally with some statuses changed (e.g. accepted elsewhere). */
export function proposals(status?: string | null, changed: Record<string, string> = {}) {
  return {
    proposals: PROPS.map((p) => ({ ...p, status: changed[p.id] ?? p.status }))
      .filter((p) => !status || p.status === status)
      .map((p) => proposalDto(p as (typeof PROPS)[number])),
  };
}
export function proposal(id: string, changed: Record<string, string> = {}) {
  const p = PROPS.find((x) => x.id === id);
  return p ? proposalDto({ ...p, status: changed[p.id] ?? p.status } as (typeof PROPS)[number]) : null;
}

// ---- Matching (prototype POL; the real role families win, R-9 analogue) ---------

const FAMILIES = ['backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'devops_sre', 'data_engineer', 'architect', 'qa_test_engineer', 'product_project_manager', 'business_analyst'];
const POL = [
  { v: 3, status: 'ACTIVE', note: 'Raise clinical evidence after credential audit', created: '2026-09-14', activated: '2026-09-15', rows: [[3, true], [3, false], [2, false], [2, false], [4, true], [2, true], [2, false], [3, true], [1, false]] },
  { v: 2, status: 'RETIRED', note: 'Add ingested-evidence rule for trades', created: '2026-05-02', activated: '2026-05-03', rows: [[3, true], [3, false], [2, false], [2, false], [3, true], [2, true], [2, false], [3, true], [1, false]] },
  { v: 1, status: 'RETIRED', note: 'Initial policy', created: '2026-01-10', activated: '2026-01-10', rows: [[2, false], [2, false], [2, false], [2, false], [2, false], [2, false], [2, false], [2, false], [1, false]] },
] as const;

const policyVersion = (p: (typeof POL)[number]) => ({
  id: `mpv_${p.v}`,
  version_number: p.v,
  status: p.status,
  evidence_thresholds: Object.fromEntries(FAMILIES.map((f, i) => [f, { count: p.rows[i]![0], requires_ingested: p.rows[i]![1] }])),
  note: p.note,
  created_by: 'op_7f3a91c2e48b',
  created_at: `${p.created}T09:00:00Z`,
  activated_by: 'op_7f3a91c2e48b',
  activated_at: `${p.activated}T09:00:00Z`,
  retired_at: p.status === 'RETIRED' ? '2026-09-15T09:00:00Z' : null,
});

export function matchingPolicy() {
  const versions = POL.map(policyVersion);
  return { active: versions.find((v) => v.status === 'ACTIVE') ?? null, versions };
}

// ---- Template variables (prototype VARS) --------------------------------------

const VARS = [
  ['talent.first_name', 'Talent first name', 'Talent', 'TEXT', ['ATS', 'SIGN'], 'talent.firstName', 'Amina', true],
  ['talent.full_name', 'Talent full name', 'Talent', 'TEXT', ['ATS', 'SIGN'], 'talent.fullName', 'Amina Diallo', true],
  ['requisition.title', 'Role title', 'Requisition', 'TEXT', ['ATS'], 'requisition.title', 'Senior Platform Engineer', true],
  ['requisition.start_date', 'Start date', 'Requisition', 'DATE', ['ATS'], 'offer.startDate', '3 Nov 2026', true],
  ['offer.base_salary', 'Base salary', 'Offer', 'CURRENCY', ['ATS'], 'offer.baseSalary', '€84,000', true],
  ['offer.terms', 'Additional terms', 'Offer', 'MULTILINE_TEXT', ['ATS'], null, 'Relocation support up to €5,000.', true],
  ['offer.hours_per_week', 'Hours per week', 'Offer', 'NUMBER', ['ATS'], 'offer.hours', '40', false],
  ['organization.legal_name', 'Organization legal name', 'Organization', 'TEXT', ['ATS', 'SIGN'], 'tenant.legalName', 'Northwind Logistics GmbH', true],
  ['organization.signatory', 'Signatory name', 'Organization', 'TEXT', ['ATS', 'SIGN'], null, 'Jonas Weber', true],
  ['document.issue_date', 'Issue date', 'Document', 'DATE', ['SIGN'], null, '24 Oct 2026', true],
] as const;

export function templateVariables() {
  return {
    variables: VARS.map(([key, label, group, type, products, binding, sample, active], i) => ({
      id: `tv_${String(i + 1).padStart(2, '0')}`,
      key,
      label,
      group_label: group,
      data_type: type,
      products: [...products],
      ats_binding_key: binding,
      sample_value: sample,
      active,
      created_at: '2026-05-01T09:00:00Z',
      updated_at: '2026-10-01T09:00:00Z',
    })),
  };
}

// ---- handlers -----------------------------------------------------------------

const seg = (path: string, i: number) => decodeURIComponent(path.split('/')[i]!);

export const REST_HANDLERS: [string, RegExp, Handler][] = [
  // Sign Personal
  ['GET', /^\/platform\/personal-review$/, () => json(personalReview())],
  ['GET', /^\/platform\/tenants\/[^/]+\/personal\/reports$/, ({ path }) => json(personalReports(seg(path, 3)))],
  ['POST', /^\/platform\/personal-invites$/, ({ body }) => json({ ...PILOT_CODE, email: (body as { email?: string })?.email ?? PILOT_CODE.email })],
  // Skills registry + detail
  ['GET', /^\/platform\/skills$/, ({ query }) => json({ skills: SKILLS.filter((s) => s.active || query.get('include_inactive') === 'true').map(skillDto) })],
  ['GET', /^\/platform\/skills\/[^/]+$/, ({ path }) => {
    const s = SKILLS.find((x) => x.id === seg(path, 3));
    return s ? json(skillDto(s)) : json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
  }],
  ['GET', /^\/platform\/skills\/[^/]+\/aliases$/, ({ path }) => {
    const s = SKILLS.find((x) => x.id === seg(path, 3));
    return json({ aliases: (s?.aliases ?? []).map(([a, t], i) => ({ id: `al_${i}`, skill_id: s!.id, alias: a, normalized_alias: a.toLowerCase(), alias_type: ALIAS_MAP[t], status: 'active' })) });
  }],
  ['GET', /^\/platform\/skills\/[^/]+\/versions$/, ({ path }) => {
    const s = SKILLS.find((x) => x.id === seg(path, 3));
    return json({ versions: (s?.versions ?? []).map(([v, f, st], i) => ({ id: `ver_${i}`, skill_id: s!.id, version: v, normalized_version: v, version_family: f, status: st === 'LEGACY' ? 'inactive' : 'active' })) });
  }],
  ['GET', /^\/platform\/skills\/[^/]+\/relationships$/, ({ path }) => {
    const s = SKILLS.find((x) => x.id === seg(path, 3));
    return json({
      relationships: (s?.rels ?? []).map(([to, ty, src, ref], i) => ({ id: `rel_${i}`, source_skill_id: s!.id, target_skill_id: to, relationship_type: ty, directionality: SYMMETRIC.has(ty) ? 'SYMMETRIC' : 'DIRECTED', status: 'active', source: SOURCE_MAP[src], source_ref: ref })),
    });
  }],
  // Review queue (counts only) + proposals
  ['GET', /^\/platform\/skill-review-queue$/, ({ query }) => {
    const min = Number(query.get('min_occurrence') ?? '1');
    const q = (query.get('surface_search') ?? '').toLowerCase();
    const rows = QUEUE.filter(([s, n]) => n >= min && (!q || s.toLowerCase().includes(q))).map(([surface_form, occurrence_count, tenant_count]) => ({ surface_form, occurrence_count, tenant_count }));
    return json({ rows, next_cursor: query.get('cursor') ? null : 'CUR' });
  }],
  ['GET', /^\/platform\/skill-proposals$/, ({ query }) => {
    const st = query.get('status');
    return json({ proposals: PROPS.filter((p) => !st || p.status === st).map(proposalDto) });
  }],
  ['GET', /^\/platform\/skill-proposals\/[^/]+$/, ({ path }) => {
    const p = PROPS.find((x) => x.id === seg(path, 3));
    return p ? json(proposalDto(p)) : json({ error: { code: 'NOT_FOUND', message: 'Proposal not found' } }, 404);
  }],
  // Matching
  ['GET', /^\/platform\/matching-policy$/, () => json(matchingPolicy())],
  // Template variables
  ['GET', /^\/platform\/template-variables$/, () => json(templateVariables())],
  // Platform admins
  ['POST', /^\/platform\/admins\/invitations$/, () => json({ tenant_id: 'tn_00ARAMOPLATFORM', user_id: 'usr_new', membership_id: 'mem_new', role_keys: ['super_admin'], status: 'invitation_sent' })],
];
