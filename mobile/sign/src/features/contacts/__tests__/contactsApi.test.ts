import { createWorkspaceClient } from '../../../api/workspaceClient';
import { recordingFetch } from '../../../testing/fakes';
import { contactInputError, createContactsApi, filterContacts } from '../contactsApi';

function api(responder: Parameters<typeof recordingFetch>[0]) {
  const http = recordingFetch(responder);
  const workspace = createWorkspaceClient({
    baseUrl: 'https://sign.aramo.ai',
    fetch: http.fetch,
    session: {
      getAccessToken: async () => 't',
      refreshAccessToken: async () => 't',
      sessionExpired: () => undefined,
    },
  });
  return { contacts: createContactsApi(workspace), calls: http.calls };
}

describe('contacts (M-A3 §5)', () => {
  it('lists saved and recent contacts', async () => {
    const t = api(() => ({
      status: 200,
      body: {
        items: [
          {
            id: 'c1',
            name: 'Dana Lee',
            email: 'dana@example.com',
            organization: 'Northwind',
            source: 'saved',
            envelope_count: 2,
            last_used_at: null,
          },
          {
            id: null,
            name: 'Sam Roy',
            email: 'sam@example.com',
            organization: null,
            source: 'recent',
            envelope_count: 1,
            last_used_at: null,
          },
        ],
      },
    }));
    const list = await t.contacts.list();
    expect(list).toEqual([
      {
        id: 'c1',
        name: 'Dana Lee',
        email: 'dana@example.com',
        organization: 'Northwind',
        source: 'saved',
      },
      { id: null, name: 'Sam Roy', email: 'sam@example.com', organization: null, source: 'recent' },
    ]);
    expect(filterContacts(list, 'north').map((c) => c.id)).toEqual(['c1']);
    expect(filterContacts(list, 'SAM@').map((c) => c.email)).toEqual(['sam@example.com']);
  });

  it('creates a contact from a typed name and email, and edits and deletes saved ones', async () => {
    const t = api((r) =>
      r.method === 'DELETE'
        ? { status: 204 }
        : {
            status: r.method === 'POST' ? 201 : 200,
            body: {
              id: 'c9',
              name: 'Ana',
              email: 'ana@example.com',
              organization: null,
              source: 'saved',
              created_at: '',
              updated_at: '',
              last_used_at: null,
            },
          },
    );
    await t.contacts.create({ name: ' Ana ', email: 'ana@example.com ', organization: '' });
    await t.contacts.update('c9', { name: 'Ana B', email: 'ana@example.com' });
    await t.contacts.remove('c9');
    expect(t.calls.map((c) => `${c.method} ${c.url.replace('https://sign.aramo.ai', '')}`)).toEqual(
      [
        'POST /v1/sign/sender/contacts',
        'PATCH /v1/sign/sender/contacts/c9',
        'DELETE /v1/sign/sender/contacts/c9',
      ],
    );
    expect(t.calls[0]!.body).toEqual({ name: 'Ana', email: 'ana@example.com', organization: null });
  });

  it('validates a typed contact like the server', () => {
    expect(contactInputError({ name: '', email: 'a@b.co' })).toBe('Enter a name.');
    expect(contactInputError({ name: 'A', email: 'not-an-email' })).toBe(
      'Enter a valid email address.',
    );
    expect(contactInputError({ name: 'A', email: 'a@b.co' })).toBeNull();
  });
});
