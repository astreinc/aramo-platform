// CCP-B4 — the Contracts screen fixtures: the pinned design's contract data
// (CCP-UI v1.0 ccp-data.js `C0`, `T0`, `PEOPLE`) ported into the REAL API DTOs
// (GET /platform/commercial/contracts[/{id}]). Where the record model differs from
// the prototype's sample history, the real shape is used and the visual region is
// a typed divergence (visual/DIVERGENCES.md, DV-B4-*). TEST-ONLY.

import type { MockOptions, Reply } from './mock-api';

const TOMAS = { user_id: '0190cccc-0000-7000-8000-0000000000t1', display_name: 'Tomás Silva', email: 'tomas.silva@aramo.ai' };
const MIGRATION_JOB = { user_id: '0190cccc-0000-7000-8000-0000000000m1', display_name: 'Migration job', email: null };

const hash = (head: string, tail: string): string => `${head}${'0'.repeat(64 - head.length - tail.length)}${tail}`;
const day = (d: string): string => `${d}T00:00:00.000Z`;

interface Seed {
  id: string;
  ref: string;
  tenant: [string, string, string];
  plan: string;
  start: string;
  end: string;
  ended: string | null;
  migrated: boolean;
  recorded_at: string;
  terms: string[];
  docs: [string, string, string, string, number | null][];
  amendments: { kind: 'AMENDMENT' | 'END'; summary: string; at: string }[];
}

const SEEDS: Seed[] = [
  {
    id: '019a0000-0000-7000-8000-0000000b4007',
    ref: 'CT-2024-007',
    tenant: ['t_halcyon', 'Halcyon Health', 'halcyon'],
    plan: 'Sign Enterprise',
    start: '2023-12-08',
    end: '2026-12-08',
    ended: null,
    migrated: true,
    recorded_at: '2025-11-14T03:00:00.000Z',
    terms: ['Sign Enterprise at $2,400 per month, negotiated (SAMPLE)', 'Allowance of 25,000 envelopes per month', 'Invoiced monthly, net 45', 'Price held for the commitment term'],
    docs: [
      ['Master services agreement.pdf', '9f2c61d0', 'a84b1e', '2023-12-04', null],
      ['Order form OF-7781.pdf', '51ad09fe', '37e07c', '2023-12-04', null],
      ['Amendment 1.pdf', 'c3e04b77', '119a42', '2024-06-11', 1],
    ],
    amendments: [{ kind: 'AMENDMENT', summary: 'Allowance raised from 20,000 to 25,000 envelopes per month.', at: '2024-06-11' }],
  },
  {
    id: '019a0000-0000-7000-8000-0000000b4021',
    ref: 'CT-2026-021',
    tenant: ['t_atlas', 'Atlas Freight', 'atlas-freight'],
    plan: 'Sign Business',
    start: '2026-05-01',
    end: '2027-04-30',
    ended: null,
    migrated: false,
    recorded_at: day('2026-05-01'),
    terms: ['Sign Business v2 at list price (SAMPLE)', 'Portal included from June 2026', 'Invoiced monthly, net 30'],
    docs: [['Order form OF-8034.pdf', '0be771c2', 'd5f310', '2026-04-28', null]],
    amendments: [{ kind: 'AMENDMENT', summary: 'Portal entitlement granted through CR-0988.', at: '2026-06-10' }],
  },
  {
    id: '019a0000-0000-7000-8000-0000000b4014',
    ref: 'CT-2025-014',
    tenant: ['t_meridian', 'Meridian Partners', 'meridian'],
    plan: 'Sign Scale',
    start: '2025-03-15',
    end: '2027-03-14',
    ended: null,
    migrated: false,
    recorded_at: day('2025-03-15'),
    terms: ['Sign Scale v1 at $260 per month, negotiated (SAMPLE)', 'Invoiced quarterly, net 30'],
    docs: [
      ['Master services agreement.pdf', '7a19c3e5', '0f62bd', '2025-03-10', null],
      ['Order form OF-7920.pdf', 'e2d48a01', 'b9c774', '2025-03-10', null],
    ],
    amendments: [],
  },
  {
    id: '019a0000-0000-7000-8000-0000000b4019',
    ref: 'CT-2024-019',
    tenant: ['t_brightline', 'Brightline Retail', 'brightline'],
    plan: 'Sign Business',
    start: '2024-10-18',
    end: '2026-10-17',
    ended: '2026-10-18',
    migrated: false,
    recorded_at: day('2024-10-18'),
    terms: ['Sign Business v1 at list price (SAMPLE)', 'Not renewed'],
    docs: [['Order form OF-7702.pdf', '44f0be13', '7c2a09', '2024-10-15', null]],
    amendments: [{ kind: 'END', summary: 'Subscription ended at commitment end through CR-1046.', at: '2026-10-18' }],
  },
];

function summary(s: Seed) {
  return {
    id: s.id,
    contract_ref: s.ref,
    tenant: { id: s.tenant[0], name: s.tenant[1], slug: s.tenant[2] },
    product_key: 'sign',
    status: s.ended === null ? 'ACTIVE' : 'ENDED',
    subscription: {
      id: `sub-${s.id.slice(-4)}`,
      source: 'MANUAL',
      status: s.ended === null ? 'ACTIVE' : 'CANCELED',
      ended_at: s.ended === null ? null : day(s.ended),
      commitment_start: day(s.start),
      commitment_end: day(s.end),
      plan: { key: `aramo-${s.plan.toLowerCase().replace(/ /g, '-')}-v1`, name: s.plan },
      plan_version: { id: `ver-${s.id.slice(-4)}`, version_number: 1, status: 'PUBLISHED' },
    },
    provenance: s.migrated ? 'MIGRATION' : 'CHANGE_REQUEST',
    recorded_at: s.recorded_at,
  };
}

function detail(s: Seed) {
  return {
    ...summary(s),
    terms: s.terms,
    recorded_terms: s.terms,
    evidence_ref: null,
    recorded_by: s.migrated ? MIGRATION_JOB : TOMAS,
    recorded_by_change_request_id: `cr-${s.id.slice(-4)}`,
    documents: s.docs.map(([name, head, tail, at, seq]) => ({ name, sha256: hash(head, tail), byte_size: null, media_type: null, recorded_by: TOMAS, recorded_at: day(at), amendment_sequence: seq })),
    amendments: s.amendments.map((a, i) => ({ sequence: i + 1, kind: a.kind, summary: a.summary, terms: null, document_count: 0, evidence_ref: null, change_request_id: `cr-a${i}`, recorded_by: TOMAS, recorded_at: day(a.at) })),
    invoicing: { enabled: false, reason: 'enterprise_invoicing_choice_pending' },
  };
}

export const CONTRACT_IDS = Object.fromEntries(SEEDS.map((s) => [s.ref, s.id])) as Record<string, string>;

/** The CCP personas of the pinned design (PEOPLE), as platform sessions (A1 §4.1 bundles). */
const CCP_SCOPES = {
  tomas: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  ines: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  daniel: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  lena: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
} as const;
export type CcpPersona = keyof typeof CCP_SCOPES;
const CCP_PEOPLE: Record<CcpPersona, { name: string; email: string; role: string }> = {
  tomas: { name: 'Tomás Silva', email: 'tomas.silva@aramo.ai', role: 'commercial_ops' },
  ines: { name: 'Ines Duarte', email: 'ines.duarte@aramo.ai', role: 'read_only_auditor' },
  daniel: { name: 'Daniel Reyes', email: 'daniel.reyes@aramo.ai', role: 'platform_owner' },
  lena: { name: 'Lena Fischer', email: 'lena.fischer@aramo.ai', role: 'catalog_manager' },
};

const IAT = Math.floor(Date.parse('2026-10-24T14:00:00Z') / 1000);

/** Mock options: a CCP persona session plus the contract routes (`list`: 'ready' | 'empty' | 'hang'). */
export function contractsMock(persona: CcpPersona, list: 'ready' | 'empty' | 'hang' = 'ready'): MockOptions {
  const p = CCP_PEOPLE[persona];
  const sub = `usr_${persona}`;
  const reply = (body: unknown, status = 200): Reply => ({ status, body });
  return {
    overrides: [
      { path: /^\/auth\/platform\/session$/, reply: reply({ sub, consumer_type: 'platform', tenant_id: 'tn_00ARAMOPLATFORM', scopes: [...CCP_SCOPES[persona]], iat: IAT, exp: IAT + 8 * 3600 }) },
      { path: /^\/platform\/me$/, reply: reply({ user_id: sub, email: p.email, display_name: p.name, tenant_id: 'tn_00ARAMOPLATFORM', tenant_name: 'Aramo Platform', role_keys: [p.role] }) },
      { path: /^\/platform\/commercial\/contracts$/, reply: list === 'hang' ? 'hang' : reply({ contracts: list === 'empty' ? [] : SEEDS.map(summary) }) },
      // The two actions only CREATE and SUBMIT a change request (never a contract write).
      { method: 'POST', path: /^\/platform\/commercial\/change-requests$/, reply: reply({ request: { id: '019a0000-0000-7000-8000-00000000cb41', state: 'DRAFT' }, replayed: false }, 201) },
      { method: 'POST', path: /^\/platform\/commercial\/change-requests\/[^/]+\/submit$/, reply: reply({ request: { id: '019a0000-0000-7000-8000-00000000cb41', state: 'PENDING_APPROVAL' } }) },
      {
        path: /^\/platform\/commercial\/contracts\/[^/]+$/,
        reply: ({ path }) => {
          const s = SEEDS.find((x) => x.id === decodeURIComponent(path.split('/').pop() ?? ''));
          return s ? reply(detail(s)) : reply({ error: { code: 'NOT_FOUND', message: 'Contract not found' } }, 404);
        },
      },
    ],
  };
}
