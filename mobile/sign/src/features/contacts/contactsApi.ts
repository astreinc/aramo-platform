// The sender's contacts (M-A3 §5; directive B-6): saved contacts (private to this
// user and tenant) merged with recent recipients. A contact grants nothing; recipients
// are validated when the envelope is sent.
import type { WorkspaceClient } from '../../api/workspaceClient';

export interface Contact {
  /** Saved contact id; null for a recent recipient. */
  readonly id: string | null;
  readonly name: string;
  readonly email: string;
  readonly organization: string | null;
  readonly source: 'saved' | 'recent';
}

export interface ContactInput {
  readonly name: string;
  readonly email: string;
  readonly organization?: string | null;
}

export const CONTACTS_QUERY_KEY = ['sign', 'sender', 'contacts'] as const;

/** The server's email rule (sender-envelope.service.ts EMAIL_RE). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  const e = email.trim();
  return e.length <= 254 && EMAIL_RE.test(e);
}

export function contactInputError(input: ContactInput): string | null {
  const name = input.name.trim();
  if (name.length === 0) return 'Enter a name.';
  if (name.length > 200) return 'The name can be at most 200 characters.';
  if (!isValidEmail(input.email)) return 'Enter a valid email address.';
  return null;
}

export interface ContactsApi {
  list(): Promise<Contact[]>;
  create(input: ContactInput): Promise<Contact>;
  update(id: string, input: ContactInput): Promise<Contact>;
  remove(id: string): Promise<void>;
}

export function createContactsApi(workspace: WorkspaceClient): ContactsApi {
  return {
    async list() {
      const out = await workspace.call('/v1/sign/sender/contacts', 'get', {});
      return out.items.map((c) => ({
        id: c.id ?? null,
        name: c.name,
        email: c.email,
        organization: c.organization ?? null,
        source: c.source,
      }));
    },
    async create(input) {
      const c = await workspace.call('/v1/sign/sender/contacts', 'post', {
        body: {
          name: input.name.trim(),
          email: input.email.trim(),
          organization: input.organization?.trim() || null,
        },
      });
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        organization: c.organization ?? null,
        source: 'saved',
      };
    },
    async update(id, input) {
      const c = await workspace.call('/v1/sign/sender/contacts/{contactId}', 'patch', {
        path: { contactId: id },
        body: {
          name: input.name.trim(),
          email: input.email.trim(),
          organization: input.organization?.trim() || null,
        },
      });
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        organization: c.organization ?? null,
        source: 'saved',
      };
    },
    async remove(id) {
      await workspace.call('/v1/sign/sender/contacts/{contactId}', 'delete', {
        path: { contactId: id },
      });
    },
  };
}

/** Search by name or email (handoff §4.6 contacts sheet). */
export function filterContacts(contacts: readonly Contact[], query: string): Contact[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...contacts];
  return contacts.filter((c) =>
    `${c.name} ${c.email} ${c.organization ?? ''}`.toLowerCase().includes(q),
  );
}
