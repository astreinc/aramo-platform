import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { readinessOf } from './pages/readiness';
import { clampBox, toPdf, toTopLeft } from './geometry';
import { tokenFromSigningLink, type EnvelopeDetail, type SenderContext } from './api';

// PX-1 — the Sign sender console. The backend context decides the workspace; the
// URL prefix never authorizes. Refusal states for an unentitled tenant and a
// user without a Sign role; sending UI only when the backend says can_send.

vi.mock('./pdf', () => ({ loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 9_999_999_999 };

function ctx(over: Partial<SenderContext> = {}): SenderContext {
  return {
    user: { id: 'u1', email: 'priya@northwind.test', display_name: 'Priya Nair' },
    tenant: { id: 't1', name: 'Northwind Staffing', kind: 'BUSINESS' },
    workspace: 'sign',
    permissions: { read: true, create: true, send: true },
    can_send: true,
    personal_sending_enabled: false,
    organization_url: 'https://northwind.aramo.ai/org/profile',
    app_home_url: 'https://northwind.aramo.ai/',
    ...over,
  };
}

const SUMMARY = {
  counts: { draft: 1, sent: 1, in_progress: 1, completed: 2, declined: 1, voided: 0, expired: 1 },
  awaiting_signatures: 2,
  completed_this_month: 2,
  declined_or_expired: 2,
  months: [{ month: '2026-10', sent: 4, completed: 2, declined_or_expired: 1 }],
  completion_rate: 50,
  expiring_soon: [],
  signing_window_days: 7,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(context: SenderContext | { error: { code: string }; status: number }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/sign/session')) return json(SESSION);
    if (url.endsWith('/v1/sign/sender/context')) return 'status' in context ? json({ error: context.error }, context.status) : json(context);
    if (url.endsWith('/v1/sign/sender/summary')) return json(SUMMARY);
    if (url.includes('/v1/sign/sender/envelopes')) return json({ items: [{ id: 'e1', subject: 'Vendor NDA — BluePeak', status: 'COMPLETED', created_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-02T00:00:00Z', last_activity_at: '2026-10-02T00:00:00Z', document_count: 1, recipients: [{ id: 's1', name: 'Sam Rivera', email: 'sam@x.test', status: 'SIGNED' }] }], counts: { COMPLETED: 1 } });
    return json({ items: [] });
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('Sign workspace App', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('/ resolves the BUSINESS workspace from the backend and shows the dashboard', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx()));
    renderAt('/');
    expect(await screen.findByText('Recent envelopes')).toBeInTheDocument();
    expect(screen.getByText('Vendor NDA — BluePeak')).toBeInTheDocument();
    expect(screen.getByTestId('new-envelope')).toHaveAttribute('href', '/sign/envelopes/new');
  });

  it('a PERSONAL account landing on /sign is redirected to /personal, with sending disabled', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ workspace: 'personal', can_send: false, tenant: { id: 't1', name: 'Priya Nair', kind: 'PERSONAL' }, organization_url: null })));
    renderAt('/sign/reports');
    expect(await screen.findByTestId('personal-note')).toBeInTheDocument();
    expect(screen.getByTestId('new-envelope-disabled')).toBeDisabled();
    expect(screen.queryByText('Reports')).not.toBeInTheDocument();
  });

  it('a tenant without the Sign subscription sees the not-part-of-your-plan page', async () => {
    vi.stubGlobal('fetch', stubFetch({ error: { code: 'TENANT_CAPABILITY_NOT_ENTITLED' }, status: 403 }));
    renderAt('/sign');
    expect(await screen.findByTestId('state-not-entitled')).toHaveTextContent('isn’t part of your plan');
  });

  it('a user without a Sign role sees the no-access page', async () => {
    vi.stubGlobal('fetch', stubFetch({ error: { code: 'INSUFFICIENT_PERMISSIONS' }, status: 403 }));
    renderAt('/sign');
    expect(await screen.findByTestId('state-no-access')).toBeInTheDocument();
  });

  it('a read-only (viewer) business user gets no New envelope action', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ can_send: false, permissions: { read: true, create: false, send: false } })));
    renderAt('/sign/envelopes');
    await waitFor(() => expect(screen.getByTestId('new-envelope-disabled')).toBeDisabled());
    expect(screen.queryByRole('link', { name: '+ New envelope' })).not.toBeInTheDocument();
  });

  // Sign Unified Product S-1 — Members appears only for holders of sign:member:manage.
  // ORG-UX-1 (LOCKED §6, H1/P7) — Sign Settings → Users & roles only points to Organization
  // → Users & product access; no role is edited here.
  it('Settings shows Users & roles only when the backend grants member administration', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ permissions: { read: true, create: true, send: true, members: true } })));
    const first = renderAt('/sign/settings/personal');
    expect(await screen.findByRole('link', { name: 'Users & roles' })).toBeInTheDocument();
    first.unmount();
    vi.stubGlobal('fetch', stubFetch(ctx()));
    renderAt('/sign/settings/personal');
    await screen.findByTestId('settings-account');
    expect(screen.queryByRole('link', { name: 'Users & roles' })).not.toBeInTheDocument();
  });

  it('Users & roles: an organization admin gets the link to Organization (with a Sign return); others are told to ask an admin', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(ctx({ permissions: { read: true, create: true, send: true, members: true }, org_admin: true, organization_roles_url: 'https://northwind.aramo.ai/org/roles' })),
    );
    const first = renderAt('/sign/settings/members');
    const link = await screen.findByTestId('settings-manage-in-org');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('https://northwind.aramo.ai/auth/org/login?')).toBe(true);
    const returnTo = new URLSearchParams(href.split('?')[1]).get('return_to') ?? '';
    expect(returnTo.startsWith('/org/roles?')).toBe(true);
    expect(new URLSearchParams(returnTo.split('?')[1]).get('from')).toBe('sign');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    first.unmount();
    vi.stubGlobal('fetch', stubFetch(ctx({ permissions: { read: true, create: true, send: true, members: true }, org_admin: false })));
    renderAt('/sign/settings/members');
    expect(await screen.findByTestId('settings-ask-org-admin')).toHaveTextContent('Ask your organization admin to change roles.');
  });

  // Sign Unified Product S-3 — ATS envelopes are listed with their origin.
  it('an envelope sent by the ATS is marked "From Aramo ATS" in the list', async () => {
    const base = stubFetch(ctx());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/v1/sign/sender/envelopes')) {
          return json({ items: [{ id: 'e9', subject: 'Right to Represent — Jordan', status: 'SENT', created_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', completed_at: null, last_activity_at: '2026-10-01T00:00:00Z', document_count: 1, source_application: 'aramo-ats', recipients: [] }], counts: { SENT: 1 } });
        }
        return base(input, init);
      }),
    );
    renderAt('/sign/envelopes');
    expect(await screen.findByText('From Aramo ATS')).toBeInTheDocument();
  });

  // DOC-TEMPLATE-LIB-1 T-5 — the Templates page follows the plan capability (sign.templates)
  // and the document_template:read permission the backend reports.
  it('Templates — plan capability NOT available: the unavailable treatment, no list call, no create action', async () => {
    const f = stubFetch(ctx({ features: { templates: false }, permissions: { read: true, create: true, send: true, templates: true } }));
    vi.stubGlobal('fetch', f);
    renderAt('/sign/templates');
    expect(await screen.findByTestId('templates-unavailable')).toHaveTextContent('Templates aren’t available on your plan yet');
    expect(screen.getByTestId('templates-unavailable-tag')).toHaveTextContent('Not available');
    expect(f.mock.calls.some(([u]) => String(u).includes('/v1/sign/sender/templates'))).toBe(false);
    expect(screen.queryByText('Future capability')).toBeNull();
  });

  it('Templates — available + permitted: lists the organization templates with Use template', async () => {
    const base = stubFetch(ctx({ features: { templates: true }, permissions: { read: true, create: true, send: true, templates: true } }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/v1/sign/sender/templates')) {
          return json({
            items: [
              {
                template_id: 'tpl-1', name: 'Standard Right to Represent', description: null,
                document_type: { id: 'dt', key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent' },
                owner_scope: 'PLATFORM', resolution: 'PLATFORM_DEFAULT', version_id: 'v1', version_number: 2, updated_at: '2026-10-21T00:00:00Z',
                variables: [{ key: 'talent.full_name', label: 'Talent full name', group: 'Talent', source: 'SENDER', value: null }],
              },
            ],
            unavailable: [],
          });
        }
        return base(input, init);
      }),
    );
    renderAt('/sign/templates');
    expect(await screen.findByText('Standard Right to Represent')).toBeInTheDocument();
    expect(screen.getByText(/Aramo default · v2/)).toBeInTheDocument();
    expect(screen.getByTestId('use-template-tpl-1')).toHaveAttribute('href', '/sign/templates/tpl-1/use');
    expect(screen.getByTestId('manage-templates-link')).toHaveAttribute('href', 'https://northwind.aramo.ai/org/document-templates');
  });

  it('Use template — sender-filled fields, then the envelope is created from the template (CORE_REF) and the wizard opens', async () => {
    const base = stubFetch(ctx({ features: { templates: true }, permissions: { read: true, create: true, send: true, templates: true } }));
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.endsWith('/v1/sign/sender/templates')) {
          return json({
            items: [
              {
                template_id: 'tpl-1', name: 'Standard Right to Represent', description: null,
                document_type: { id: 'dt', key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent' },
                owner_scope: 'PLATFORM', resolution: 'PLATFORM_DEFAULT', version_id: 'v1', version_number: 2, updated_at: '2026-10-21T00:00:00Z',
                variables: [
                  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent', source: 'SENDER', value: null },
                  { key: 'organization.name', label: 'Organization name', group: 'Organization', source: 'ORGANIZATION', value: 'Northwind Staffing' },
                ],
              },
            ],
            unavailable: [],
          });
        }
        if (u.endsWith('/v1/sign/sender/envelopes/from-template')) {
          calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
          return json({ envelope: { id: 'env-9' }, template: { template_id: 'tpl-1', version_id: 'v1', version_number: 2 }, suggested_fields: [] }, 201);
        }
        return base(input, init);
      }),
    );
    renderAt('/sign/templates/tpl-1/use');
    const input = await screen.findByTestId('template-var-talent.full_name');
    expect(screen.getAllByText('Northwind Staffing').length).toBeGreaterThan(0);
    const create = screen.getByTestId('create-from-template');
    expect(create).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Jordan Signer' } });
    expect(create).not.toBeDisabled();
    fireEvent.click(create);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ template_id: 'tpl-1', values: { 'talent.full_name': 'Jordan Signer' } });
    expect(typeof (calls[0]?.body as { idempotency_key?: unknown }).idempotency_key).toBe('string');
    expect((calls[0]?.body as Record<string, unknown>)['values']).not.toHaveProperty('organization.name');
  });

  // Amendment M-A6 §3.5 / §3.7 — a template with signing roles: list metadata, one person
  // per signing role (copy roles optional), routing + message from the template, sent as
  // recipients / cc (never the single signer).
  it('Templates — list metadata of a multi-role template (signers, copies, routing)', async () => {
    const base = stubFetch(ctx({ features: { templates: true }, permissions: { read: true, create: true, send: true, templates: true } }));
    const tpl = {
      template_id: 'tpl-2', name: 'Mutual Agreement', description: 'Two-party agreement',
      document_type: { id: 'dt', key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent' },
      owner_scope: 'TENANT', resolution: 'AVAILABLE', is_default: false, version_id: 'v1', version_number: 1, updated_at: '2026-10-21T00:00:00Z',
      variables: [{ key: 'requisition.title', label: 'Requisition title', group: 'Requisition', source: 'SENDER', value: null }],
      category: 'Right to Represent', signer_role_count: 2, cc_role_count: 1, document_count: 1, routing_mode: 'SEQUENTIAL',
      signing: {
        roles: [
          { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
          { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
          { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
        ],
        routing_mode: 'SEQUENTIAL',
        default_message: 'Please sign',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.endsWith('/v1/sign/sender/templates')) return json({ items: [tpl], unavailable: [] });
        return base(input, init);
      }),
    );
    renderAt('/sign/templates');
    expect(await screen.findByTestId('template-meta-tpl-2')).toHaveTextContent('2 signers · 1 copy · signs in order');
  });

  it('Use template — multi-role binding: every signing role needs a person; distinct emails; recipients + cc are sent', async () => {
    const base = stubFetch(ctx({ features: { templates: true }, permissions: { read: true, create: true, send: true, templates: true } }));
    const calls: Array<{ url: string; body: unknown }> = [];
    const tpl = {
      template_id: 'tpl-2', name: 'Mutual Agreement', description: null,
      document_type: { id: 'dt', key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent' },
      owner_scope: 'TENANT', resolution: 'AVAILABLE', is_default: false, version_id: 'v1', version_number: 1, updated_at: '2026-10-21T00:00:00Z',
      variables: [],
      category: 'Right to Represent', signer_role_count: 2, cc_role_count: 1, document_count: 1, routing_mode: 'SEQUENTIAL',
      signing: {
        roles: [
          { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
          { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
          { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
        ],
        routing_mode: 'SEQUENTIAL',
        default_message: 'Please sign',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.endsWith('/v1/sign/sender/templates')) return json({ items: [tpl], unavailable: [] });
        if (u.endsWith('/v1/sign/sender/envelopes/from-template')) {
          calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
          return json({ envelope: { id: 'env-10' }, template: { template_id: 'tpl-2', version_id: 'v1', version_number: 1 }, suggested_fields: [], signing: tpl.signing }, 201);
        }
        return base(input, init);
      }),
    );
    renderAt('/sign/templates/tpl-2/use');
    await screen.findByTestId('template-roles');
    expect(screen.queryByLabelText('First signer’s name (optional)')).toBeNull();
    const create = screen.getByTestId('create-from-template');
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId('role-name-client'), { target: { value: 'Casey Client' } });
    fireEvent.change(screen.getByTestId('role-email-client'), { target: { value: 'casey@client.test' } });
    fireEvent.change(screen.getByTestId('role-name-agency'), { target: { value: 'Avery Agency' } });
    fireEvent.change(screen.getByTestId('role-email-agency'), { target: { value: 'CASEY@client.test' } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId('role-email-agency'), { target: { value: 'avery@agency.test' } });
    expect(create).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('role-name-hr_copy'), { target: { value: 'HR' } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId('role-email-hr_copy'), { target: { value: 'hr@client.test' } });
    expect(screen.getByTestId('template-routing')).toHaveValue('SEQUENTIAL');
    expect(screen.getByTestId('template-message')).toHaveValue('Please sign');
    fireEvent.click(create);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      template_id: 'tpl-2',
      recipients: [
        { role_key: 'client', name: 'Casey Client', email: 'casey@client.test' },
        { role_key: 'agency', name: 'Avery Agency', email: 'avery@agency.test' },
      ],
      cc: [{ role_key: 'hr_copy', name: 'HR', email: 'hr@client.test' }],
      routing_mode: 'SEQUENTIAL',
      message: 'Please sign',
    });
    expect(calls[0]?.body).not.toHaveProperty('signer');
  });

  it('Templates — available but no document_template:read: no access message', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ features: { templates: true }, permissions: { read: true, create: true, send: true, templates: false } })));
    renderAt('/sign/templates');
    expect(await screen.findByTestId('templates-unavailable')).toHaveTextContent('You don’t have access to templates');
  });
});

describe('send readiness (mirrors the server)', () => {
  const base = { documents: [{ id: 'd1' }], recipients: [{ id: 's1', name: 'Alex' }, { id: 's2', name: 'Priya' }], fields: [{ signer_id: 's1', field_type: 'SIGNATURE' }] } as unknown as EnvelopeDetail;
  it('every signer needs a signature field', () => {
    expect(readinessOf(base)).toMatchObject({ ok: false });
    expect(readinessOf(base).items.at(-1)?.t).toBe('Priya needs a signature field');
    expect(readinessOf({ ...base, fields: [...base.fields, { signer_id: 's2', field_type: 'SIGNATURE' }] } as unknown as EnvelopeDetail).ok).toBe(true);
  });
  it('needs a document and a signer', () => {
    expect(readinessOf({ documents: [], recipients: [], fields: [] } as unknown as EnvelopeDetail).items.map((i) => i.t)).toEqual(['Add at least one document', 'Add at least one signer']);
  });
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §1.5 / §6.2 — the mirror excludes copy recipients.
  it('a copy recipient is not a signer, needs no field, and must have none', () => {
    const withCopy = { ...base, recipients: [{ id: 's1', name: 'Alex' }, { id: 'c1', name: 'Casey', recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' }] } as unknown as EnvelopeDetail;
    expect(readinessOf(withCopy)).toMatchObject({ ok: true });
    expect(readinessOf(withCopy).items[1]?.t).toBe('1 signer(s)');
    const onlyCopy = { ...base, recipients: [{ id: 'c1', name: 'Casey', recipient_kind: 'RECEIVES_COPY' }], fields: [] } as unknown as EnvelopeDetail;
    expect(readinessOf(onlyCopy).items.map((i) => i.t)).toContain('Add at least one signer');
    const copyWithField = { ...withCopy, fields: [...base.fields, { signer_id: 'c1', field_type: 'TEXT' }] } as unknown as EnvelopeDetail;
    expect(readinessOf(copyWithField).items.at(-1)).toEqual({ ok: false, t: 'Casey receives a copy and cannot have fields' });
  });
});

// M-A5 §6.2 — the web Role select: Receives a copy (with timing) and Assign to me. In
// person is not offered on the web this release.
describe('envelope wizard — recipient roles (M-A5)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  const DRAFT = {
    id: 'e9',
    subject: 'Roles',
    status: 'DRAFT',
    created_at: '2026-10-01T00:00:00Z',
    sent_at: null,
    completed_at: null,
    declined_at: null,
    voided_at: null,
    expires_at: null,
    signing_window_days: 7,
    sender: { id: 'u1', name: 'Priya Nair' },
    editable: true,
    routing_mode: 'PARALLEL',
    next_signer_id: null,
    documents: [],
    recipients: [
      { id: 'r1', name: 'Priya Nair', email: 'priya@northwind.test', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', copy_delivery: null, assigned_to_me: false },
      { id: 'r2', name: 'Casey', email: 'casey@x.test', status: 'PENDING', signing_order: 2, recipient_kind: 'SIGNER', copy_delivery: null, assigned_to_me: false },
    ],
    fields: [],
  };

  it('saves Receives a copy with its timing and Assign to me for the signed-in user only', async () => {
    const puts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/auth/sign/session')) return json(SESSION);
        if (url.endsWith('/v1/sign/sender/context')) return json(ctx());
        if (url.endsWith('/v1/sign/sender/envelopes/e9/recipients') && init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          return json(DRAFT);
        }
        if (url.endsWith('/v1/sign/sender/envelopes/e9')) return json(DRAFT);
        return json({ items: [] });
      }),
    );
    renderAt('/sign/envelopes/e9/edit?step=2');
    const roles = await screen.findAllByTestId('recipient-role');
    expect(roles).toHaveLength(2);
    expect(screen.queryByRole('option', { name: /in person/i })).not.toBeInTheDocument();
    // Only the signed-in user's own row offers Assign to me.
    expect(screen.getAllByTestId('assign-to-me')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('assign-to-me'));
    fireEvent.change(roles[1]!, { target: { value: 'RECEIVES_COPY' } });
    fireEvent.change(await screen.findByTestId('copy-timing'), { target: { value: 'BOTH' } });
    fireEvent.click(screen.getByTestId('recipients-continue'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      recipients: [
        { id: 'r1', name: 'Priya Nair', email: 'priya@northwind.test', recipient_kind: 'SIGNER', copy_delivery: null, assign_to_me: true },
        { id: 'r2', name: 'Casey', email: 'casey@x.test', recipient_kind: 'RECEIVES_COPY', copy_delivery: 'BOTH' },
      ],
    });
  });
});

describe('editor geometry (top-left editor ⇄ bottom-left PDF)', () => {
  it('round-trips a box and matches the stamper frame', () => {
    const tl = { x: 72, y: 100, width: 220, height: 48 };
    const pdf = toPdf(tl, 792);
    expect(pdf).toEqual({ x: 72, y: 644, width: 220, height: 48 });
    expect(toTopLeft(pdf, 792)).toEqual(tl);
  });
  it('clamps a box inside its page with a 14pt minimum', () => {
    expect(clampBox({ x: 600, y: -5, width: 220, height: 4 }, { width: 612, height: 792 })).toEqual({ x: 392, y: 0, width: 220, height: 14 });
  });
});

// Sign Unified Product S-7 — "Waiting for me".
describe('recipient inbox', () => {
  const ITEM = { id: 'b1', subject: 'Offer letter', from: 'Northwind Staffing', envelope_status: 'SENT', my_status: 'PENDING', sent_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-31T00:00:00Z', completed_at: null, signed_at: null, can_sign: true, can_download: false };

  it('extracts the token from a pasted signing link; refuses anything else', () => {
    expect(tokenFromSigningLink('https://sign.aramo.ai/s/abcdefghijklmnopqrstuvwxyz0123')).toBe('abcdefghijklmnopqrstuvwxyz0123');
    expect(tokenFromSigningLink('  abcdefghijklmnopqrstuvwxyz0123 ')).toBe('abcdefghijklmnopqrstuvwxyz0123');
    expect(tokenFromSigningLink('https://evil.example/x')).toBeNull();
    expect(tokenFromSigningLink('short')).toBeNull();
  });

  it('lists documents waiting for the user — even a user with no Sign role', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/sign/session')) return json({ ...SESSION, scopes: [] });
        if (url.endsWith('/v1/sign/inbox')) return json({ waiting: [ITEM], completed: [], other: [] });
        return json({ error: { code: 'INSUFFICIENT_PERMISSIONS' } }, 403);
      }),
    );
    renderAt('/inbox');
    expect(await screen.findByText('Offer letter')).toBeInTheDocument();
    expect(screen.getByText('Northwind Staffing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign' })).toBeInTheDocument();
  });

  it('inside the workspace the inbox keeps the console navigation', async () => {
    const base = stubFetch(ctx());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/v1/sign/inbox')) return json({ waiting: [ITEM], completed: [], other: [] });
        return base(input);
      }),
    );
    renderAt('/sign/inbox');
    expect(await screen.findByText('Offer letter')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Waiting for me/ })).toHaveAttribute('href', '/sign/inbox');
    expect(screen.getByRole('link', { name: /Envelopes/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
  });

  it('the no-Sign-role state links to the documents sent to the user', async () => {
    vi.stubGlobal('fetch', stubFetch({ error: { code: 'INSUFFICIENT_PERMISSIONS' }, status: 403 }));
    renderAt('/sign');
    expect(await screen.findByTestId('state-no-access')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Documents sent to you for signature' })).toHaveAttribute('href', '/inbox');
  });
});
