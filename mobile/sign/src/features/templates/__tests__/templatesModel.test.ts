// Templates screen (M-A4 §6.4): only returned metadata, unavailable states with the
// server's reason, and the library read from GET /v1/sign/sender/templates.
import { createWorkspaceClient } from '../../../api/workspaceClient';
import { recordingFetch } from '../../../testing/fakes';
import { loadTemplateLibrary, listTemplates, type SenderTemplate } from '../../send/templates';
import {
  FEATURE_UNAVAILABLE,
  NO_TEMPLATE_PERMISSION,
  NO_TEMPLATES,
  contextRefusal,
  templateMeta,
  templatesView,
  unavailableNote,
} from '../templatesModel';

function workspace(responder: Parameters<typeof recordingFetch>[0]) {
  const http = recordingFetch(responder);
  return {
    calls: http.calls,
    workspace: createWorkspaceClient({
      baseUrl: 'https://sign.aramo.ai',
      fetch: http.fetch,
      session: {
        getAccessToken: async () => 't',
        refreshAccessToken: async () => 't',
        sessionExpired: () => undefined,
      },
    }),
  };
}

const ITEM = {
  template_id: '6f1c2c1e-3a51-4b44-9a3e-1f0f6a1d2b3c',
  name: 'Right to represent',
  description: 'Standard RTR for contract roles.',
  document_type: { id: 'dt1', key: 'rtr', name: 'Right to represent' },
  owner_scope: 'TENANT',
  resolution: 'TENANT_SELECTION',
  version_id: 'v1',
  version_number: 3,
  updated_at: '2026-10-01T00:00:00Z',
  variables: [
    { key: 'organization.name', label: 'Organization', group: 'org', source: 'ORGANIZATION', value: 'Northwind' },
    { key: 'talent.full_name', label: 'Talent name', group: 'talent', source: 'SENDER', value: null },
  ],
};

const OK_CONTEXT = { features: { templates: true }, permissions: { templates: true } };

describe('template library (GET /v1/sign/sender/templates)', () => {
  it('parses only the returned metadata and the SENDER variables', async () => {
    const w = workspace(() => ({
      status: 200,
      body: { items: [ITEM], unavailable: [{ document_type_id: 'dt2', reason: 'TEMPLATE_SELECTION_REQUIRED' }] },
    }));
    const lib = await loadTemplateLibrary(w.workspace);
    expect(w.calls[0]!.url).toBe('https://sign.aramo.ai/v1/sign/sender/templates');
    expect(lib).toEqual({
      kind: 'ok',
      items: [
        {
          id: ITEM.template_id,
          name: 'Right to represent',
          documentType: 'Right to represent',
          description: 'Standard RTR for contract roles.',
          versionNumber: 3,
          senderVariables: [{ key: 'talent.full_name', label: 'Talent name', source: 'SENDER' }],
        },
      ],
      unavailable: [{ documentTypeId: 'dt2', reason: 'TEMPLATE_SELECTION_REQUIRED' }],
    });
  });

  it('reports a refusal with the server reason instead of throwing', async () => {
    const w = workspace(() => ({
      status: 403,
      body: { error: { code: 'ESIGN_FEATURE_NOT_AVAILABLE', message: 'x', details: {} } },
    }));
    const lib = await loadTemplateLibrary(w.workspace);
    expect(lib).toMatchObject({ kind: 'unavailable', code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    expect(await listTemplates(w.workspace)).toBeNull();
  });
});

describe('templates view', () => {
  const t: SenderTemplate = {
    id: 't1',
    name: 'Offer letter',
    documentType: 'Offer',
    description: null,
    versionNumber: 2,
    senderVariables: [],
  };

  it('shows the document type and version, nothing invented', () => {
    expect(templateMeta(t)).toBe('Offer · Version 2');
    expect(templateMeta({ ...t, documentType: '', versionNumber: null })).toBeNull();
  });

  it('follows the context: plan capability first, then permission', () => {
    expect(contextRefusal(OK_CONTEXT)).toBeNull();
    expect(contextRefusal({ features: { templates: false }, permissions: { templates: true } })).toBe(FEATURE_UNAVAILABLE);
    expect(contextRefusal({ features: { templates: true }, permissions: {} })).toBe(NO_TEMPLATE_PERMISSION);
  });

  it('derives loading, unavailable, empty and list states', () => {
    const base = { contextLoading: false, libraryLoading: false, error: null };
    expect(templatesView({ ...base, context: undefined, contextLoading: true, library: undefined })).toEqual({ kind: 'loading' });
    expect(
      templatesView({ ...base, context: { features: {}, permissions: {} }, library: undefined }),
    ).toEqual({ kind: 'unavailable', message: FEATURE_UNAVAILABLE });
    expect(
      templatesView({
        ...base,
        context: OK_CONTEXT,
        library: { kind: 'unavailable', reason: 'INSUFFICIENT_PERMISSIONS', code: 'INSUFFICIENT_PERMISSIONS' },
      }),
    ).toEqual({ kind: 'unavailable', message: NO_TEMPLATE_PERMISSION });
    expect(
      templatesView({ ...base, context: OK_CONTEXT, library: { kind: 'ok', items: [], unavailable: [] } }),
    ).toEqual({ kind: 'empty', message: NO_TEMPLATES, note: null });
    const list = templatesView({
      ...base,
      context: OK_CONTEXT,
      library: { kind: 'ok', items: [t], unavailable: [{ documentTypeId: 'x', reason: 'RTR_TEMPLATE_CONFIGURATION_INVALID' }] },
    });
    expect(list.kind).toBe('list');
    if (list.kind === 'list') {
      expect(list.rows.map((r) => [r.title, r.meta])).toEqual([['Offer letter', 'Offer · Version 2']]);
      expect(list.note).toBe('1 more template can’t be used right now. An admin can check it on the web.');
    }
  });

  it('explains document types that need an admin choice', () => {
    expect(unavailableNote([])).toBeNull();
    expect(
      unavailableNote([{ reason: 'TEMPLATE_SELECTION_REQUIRED' }, { reason: 'TEMPLATE_SELECTION_REQUIRED' }]),
    ).toBe('2 more templates can’t be used until an admin chooses them on the web.');
  });

  it('never renders role binding (multi-role templates are not built yet)', () => {
    const list = templatesView({
      context: OK_CONTEXT,
      contextLoading: false,
      libraryLoading: false,
      error: null,
      library: { kind: 'ok', items: [t], unavailable: [] },
    });
    expect(JSON.stringify(list)).not.toMatch(/role/i);
  });
});
