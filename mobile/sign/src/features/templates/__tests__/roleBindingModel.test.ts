// Role binding for templates with signing roles (Amendment M-A6 §3.5): client checks that
// mirror the server, the from-template body, routing/message, refusal copy and the step
// the Send flow opens on.
import { ApiError } from '../../../api/errors';
import { createWorkspaceClient } from '../../../api/workspaceClient';
import { recordingFetch } from '../../../testing/fakes';
import { parseEnvelope } from '../../send/draftModel';
import { createFromTemplate, type TemplateRole, type TemplateSigning } from '../../send/templates';
import {
  ALREADY_BOUND,
  MAX_COPY_RECIPIENTS,
  ROLES_CHANGED,
  ROLE_USE_FAILED,
  assignMe,
  bindPerson,
  clearRole,
  initialRoleBinding,
  issueText,
  landingStep,
  roleBindingIssues,
  roleBindingRequest,
  roleRefusal,
  routingEditable,
  setMessage,
  setRouting,
  usesRoleBinding,
} from '../roleBindingModel';

const SIGNING: TemplateSigning = {
  routingMode: 'SEQUENTIAL',
  defaultSubject: null,
  defaultMessage: 'Please review and sign.',
  roles: [
    { roleKey: 'consultant', label: 'Consultant', kind: 'SIGNER', order: 1 },
    { roleKey: 'client', label: 'Client', kind: 'SIGNER', order: 2 },
    { roleKey: 'hr', label: 'HR', kind: 'CC', order: 3 },
  ],
};

const DANA = { name: 'Dana Lee', email: 'dana@example.com' };
const SAM = { name: 'Sam Ortiz', email: 'sam@example.com' };
const ME = { name: 'Priya Nair', email: 'priya@northwind.test' };

function bound() {
  let s = initialRoleBinding(SIGNING);
  s = bindPerson(s, SIGNING, 'consultant', DANA).state;
  s = bindPerson(s, SIGNING, 'client', SAM).state;
  return s;
}

describe('role binding state', () => {
  it('starts unbound with the template routing and default message', () => {
    const s = initialRoleBinding(SIGNING);
    expect(s).toEqual({
      people: { consultant: null, client: null, hr: null },
      routingMode: 'SEQUENTIAL',
      message: 'Please review and sign.',
    });
    expect(initialRoleBinding({ ...SIGNING, defaultMessage: null }).message).toBe('');
  });

  it('refuses an email another role already has (distinct emails, any case)', () => {
    const s = bound();
    const out = bindPerson(s, SIGNING, 'hr', { name: 'Dana', email: 'DANA@example.com ' });
    expect(out.result).toBe('duplicate');
    expect(out.state).toBe(s);
    // Re-binding the same role to the same person is not a duplicate.
    expect(bindPerson(s, SIGNING, 'consultant', DANA).result).toBe('bound');
    expect(bindPerson(s, SIGNING, 'nope', DANA).result).toBe('unknown_role');
  });

  it('assigns the signed-in user to a SIGNER role only', () => {
    const s = initialRoleBinding(SIGNING);
    const out = assignMe(s, SIGNING, 'client', ME);
    expect(out.result).toBe('bound');
    expect(out.state.people['client']).toEqual(ME);
    expect(assignMe(s, SIGNING, 'hr', ME).result).toBe('unknown_role');
    expect(assignMe(out.state, SIGNING, 'consultant', ME).result).toBe('duplicate');
    expect(ALREADY_BOUND).toMatch(/another role/);
  });

  it('clears a role, and edits routing and the message', () => {
    const s = clearRole(bound(), 'client');
    expect(s.people['client']).toBeNull();
    expect(setRouting(s, 'PARALLEL').routingMode).toBe('PARALLEL');
    expect(setMessage(s, 'Hi').message).toBe('Hi');
  });

  it('shows the routing control only with 2+ signer roles', () => {
    expect(routingEditable(SIGNING)).toBe(true);
    expect(routingEditable({ ...SIGNING, roles: [SIGNING.roles[0]!, SIGNING.roles[2]!] })).toBe(false);
  });
});

describe('client validation mirrors the server', () => {
  it('requires every SIGNER role, never a CC role', () => {
    const s = bindPerson(initialRoleBinding(SIGNING), SIGNING, 'consultant', DANA).state;
    expect(roleBindingIssues(SIGNING, s)).toEqual([{ kind: 'role_unbound', roleKey: 'client', label: 'Client' }]);
    expect(roleBindingIssues(SIGNING, bound())).toEqual([]);
    expect(issueText({ kind: 'role_unbound', roleKey: 'client', label: 'Client' })).toBe('Choose a person for Client.');
  });

  it('flags a bad name or email, duplicates and the limits', () => {
    const people = { consultant: { name: ' ', email: 'x' }, client: SAM, hr: { name: 'Sam', email: 'SAM@example.com' } };
    const issues = roleBindingIssues(SIGNING, { ...bound(), people });
    expect(issues.map((i) => i.kind)).toEqual(['name_required', 'email_invalid', 'duplicate_email']);

    const many: TemplateSigning = {
      ...SIGNING,
      roles: [
        ...Array.from({ length: 11 }, (_, i): TemplateRole => ({ roleKey: `s${i}`, label: `S${i}`, kind: 'SIGNER', order: i + 1 })),
        ...Array.from({ length: MAX_COPY_RECIPIENTS + 1 }, (_, i): TemplateRole => ({ roleKey: `c${i}`, label: `C${i}`, kind: 'CC', order: 20 + i })),
      ],
    };
    const all = Object.fromEntries(many.roles.map((r) => [r.roleKey, { name: r.label, email: `${r.roleKey}@example.com` }]));
    const kinds = roleBindingIssues(many, { people: all, routingMode: 'PARALLEL', message: 'x'.repeat(1001) }).map((i) => i.kind);
    expect(kinds).toEqual(['too_many_signers', 'too_many_copy_recipients', 'message_too_long']);
  });
});

describe('the from-template body', () => {
  it('is null while anything is missing', () => {
    expect(roleBindingRequest(SIGNING, initialRoleBinding(SIGNING))).toBeNull();
  });

  it('sends SIGNER roles in role order, bound CC roles, routing and the message', () => {
    let s = bindPerson(bound(), SIGNING, 'hr', { name: ' Hana ', email: ' hana@example.com ' }).state;
    s = setRouting(s, 'PARALLEL');
    expect(roleBindingRequest(SIGNING, s)).toEqual({
      recipients: [
        { role_key: 'consultant', name: 'Dana Lee', email: 'dana@example.com' },
        { role_key: 'client', name: 'Sam Ortiz', email: 'sam@example.com' },
      ],
      cc: [{ role_key: 'hr', name: 'Hana', email: 'hana@example.com' }],
      routing_mode: 'PARALLEL',
      message: 'Please review and sign.',
    });
  });

  it('leaves an unbound CC role out and sends an emptied message as null', () => {
    const out = roleBindingRequest(SIGNING, setMessage(bound(), '   '));
    expect(out?.cc).toEqual([]);
    expect(out?.message).toBeNull();
    expect(out?.routing_mode).toBe('SEQUENTIAL');
  });

  it('posts recipients/cc/routing_mode/message and no signer; no empty cc', async () => {
    const http = recordingFetch(() => ({
      status: 201,
      body: { envelope: { id: 'env-1', revision: 1, status: 'DRAFT', documents: [], recipients: [], fields: [] } },
    }));
    const workspace = createWorkspaceClient({
      baseUrl: 'https://sign.aramo.ai',
      fetch: http.fetch,
      session: { getAccessToken: async () => 't', refreshAccessToken: async () => 't', sessionExpired: () => undefined },
    });
    const binding = roleBindingRequest(SIGNING, bound())!;
    await createFromTemplate(workspace, { templateId: 'tpl', values: { a: 'b' }, idempotencyKey: 'key-12345', binding });
    const body = http.calls[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      template_id: 'tpl',
      values: { a: 'b' },
      idempotency_key: 'key-12345',
      recipients: binding.recipients,
      routing_mode: 'SEQUENTIAL',
      message: 'Please review and sign.',
    });
    expect(body['signer']).toBeUndefined();
  });
});

describe('refusals', () => {
  const err = (status: number, reason: string, code = 'VALIDATION_ERROR') => new ApiError({ status, code, reason });

  it('template_roles_changed asks for a list refresh', () => {
    expect(roleRefusal(err(409, 'template_roles_changed', 'TEMPLATE_VERSION_NOT_ACTIVE'))).toEqual({
      message: ROLES_CHANGED,
      refreshList: true,
    });
    expect(roleRefusal(err(400, 'template_has_no_roles')).refreshList).toBe(true);
    expect(roleRefusal(err(400, 'unknown_role')).refreshList).toBe(true);
  });

  it('shows the server reason for binding refusals', () => {
    for (const reason of ['template_has_roles', 'role_bound_twice', 'role_unbound', 'duplicate_email', 'too_many_signers', 'too_many_copy_recipients', 'copy_recipients_unavailable']) {
      const out = roleRefusal(err(reason === 'copy_recipients_unavailable' ? 422 : 400, reason));
      expect(out.refreshList).toBe(false);
      expect(out.message).not.toBe(ROLE_USE_FAILED);
    }
    expect(roleRefusal(err(400, 'duplicate_email')).message).toMatch(/different person/);
  });

  it('falls back to the library copy for 403/404 and a generic message otherwise', () => {
    expect(roleRefusal(err(403, 'ESIGN_FEATURE_NOT_AVAILABLE', 'ESIGN_FEATURE_NOT_AVAILABLE')).message).toMatch(/aren’t available/);
    expect(roleRefusal(err(404, 'not_a_usable_template', 'TEMPLATE_NOT_FOUND')).refreshList).toBe(true);
    expect(roleRefusal(new Error('boom'))).toEqual({ message: ROLE_USE_FAILED, refreshList: false });
  });
});

describe('which path Use takes, and where the Send flow opens', () => {
  it('binds roles only for a template with roles while the feature is on', () => {
    expect(usesRoleBinding({ signing: SIGNING })).toBe(true);
    expect(usesRoleBinding({ signing: null })).toBe(false);
    expect(usesRoleBinding({ signing: SIGNING }, false)).toBe(false);
  });

  it('opens on Review when every signer has a signature field, else Recipients', () => {
    const env = parseEnvelope({
      id: 'e',
      documents: [{ id: 'd1', title: 'Agreement' }],
      recipients: [
        { id: 'r1', name: 'Dana', email: 'dana@example.com', signing_order: 1 },
        { id: 'r2', name: 'Sam', email: 'sam@example.com', signing_order: 2 },
        { id: 'r3', name: 'Hana', email: 'hana@example.com', signing_order: 3, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' },
      ],
      fields: [
        { id: 'f1', envelope_document_id: 'd1', signer_id: 'r1', field_type: 'SIGNATURE', page_number: 1, x: 0, y: 0 },
        { id: 'f2', envelope_document_id: 'd1', signer_id: 'r2', field_type: 'SIGNATURE', page_number: 1, x: 0, y: 0 },
      ],
    });
    expect(landingStep(env)).toBe('review');
    expect(landingStep({ ...env, fields: env.fields.slice(0, 1) })).toBe('recipients');
    expect(landingStep({ ...env, documents: [] })).toBe('recipients');
    expect(landingStep({ ...env, recipients: env.recipients.slice(2) })).toBe('recipients');
  });
});
