// "Add recipient" contacts sheet (handoff §4.6 Step 2; M-A3 §5; directive B-6).
//   - Search by name or email. The list starts with the user, then saved and recent
//     contacts (GET /v1/sign/sender/contacts). Already-added people are greyed, "Added".
//   - New contact: a typed name and email, saved with POST and added as a signer.
//     Offline, the person is added to this envelope only (saving needs the server).
//   - Manage contacts: edit (PATCH) and delete (DELETE) saved contacts.
// Every recipient signs (C-11): there is no copy-only choice here.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { ListRow, RowTile } from '../../components/ListRow';
import { Sheet } from '../../components/Sheet';
import { recipientColor, useTheme } from '../../theme';
import { ErrorText, TextField } from '../send/ui';
import {
  CONTACTS_QUERY_KEY,
  contactInputError,
  createContactsApi,
  filterContacts,
  type Contact,
  type ContactInput,
} from './contactsApi';

export type PickResult = 'added' | 'duplicate' | 'full';

export interface ContactsSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly me: { readonly name: string; readonly email: string } | null;
  readonly addedEmails: ReadonlySet<string>;
  readonly online: boolean;
  readonly onPick: (person: { readonly name: string; readonly email: string }) => PickResult;
}

type View_ =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'manage' }
  | { kind: 'edit'; contact: Contact };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

const PICK_ERROR: Record<Exclude<PickResult, 'added'>, string> = {
  duplicate: 'This person is already on the envelope.',
  full: 'An envelope can have up to 10 signers.',
};

export function ContactsSheet({
  visible,
  onClose,
  me,
  addedEmails,
  online,
  onPick,
}: ContactsSheetProps) {
  const t = useTheme();
  const { workspace } = useServices();
  const api = useMemo(() => createContactsApi(workspace), [workspace]);
  const qc = useQueryClient();
  const contacts = useQuery({
    queryKey: CONTACTS_QUERY_KEY,
    queryFn: () => api.list(),
    enabled: visible,
    meta: { persist: true },
  });
  const [view, setView] = useState<View_>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setView({ kind: 'list' });
    setQuery('');
    setError(null);
    onClose();
  };

  const pick = (person: { name: string; email: string }) => {
    const r = onPick(person);
    if (r === 'added') close();
    else setError(PICK_ERROR[r]);
  };

  const people: Contact[] = useMemo(() => {
    const list = contacts.data ?? [];
    const mine: Contact[] = me
      ? [{ id: null, name: me.name, email: me.email, organization: 'You', source: 'recent' }]
      : [];
    const rest = list.filter((c) => !me || c.email.toLowerCase() !== me.email.toLowerCase());
    return filterContacts([...mine, ...rest], query);
  }, [contacts.data, me, query]);

  const title =
    view.kind === 'new'
      ? 'New contact'
      : view.kind === 'manage'
        ? 'Manage contacts'
        : view.kind === 'edit'
          ? 'Edit contact'
          : 'Add recipient';

  return (
    <Sheet visible={visible} onClose={close} title={title}>
      {view.kind === 'list' ? (
        <>
          <TextField
            label="Search"
            placeholder="Name or email"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          <ErrorText>{error}</ErrorText>
          <View
            style={[
              styles.list,
              { backgroundColor: t.color.surface, borderRadius: t.size.cardRadius },
            ]}
          >
            {people.map((c, i) => {
              const added = addedEmails.has(c.email.toLowerCase());
              const color = recipientColor(i);
              return (
                <View key={`${c.source}:${c.id ?? c.email}`} style={added ? styles.added : null}>
                  <ListRow
                    title={c.name}
                    subtitle={c.organization ? `${c.email} · ${c.organization}` : c.email}
                    trailing={added ? 'Added' : undefined}
                    leading={
                      <RowTile background={`${color}22`} color={color}>
                        <Text style={{ color, fontWeight: '600' }}>{initials(c.name)}</Text>
                      </RowTile>
                    }
                    accessibilityLabel={
                      added ? `${c.name}, ${c.email}, added` : `${c.name}, ${c.email}`
                    }
                    {...(added ? {} : { onPress: () => pick({ name: c.name, email: c.email }) })}
                    showSeparator={i < people.length - 1}
                  />
                </View>
              );
            })}
            {people.length === 0 ? (
              <Text style={[styles.empty, { color: t.color.textSecondary }]}>
                {contacts.isLoading ? 'Loading contacts…' : 'No matches. Add a new contact.'}
              </Text>
            ) : null}
          </View>
          <Button
            title="New contact"
            variant="secondary"
            onPress={() => setView({ kind: 'new' })}
          />
          <Button
            title="Manage contacts"
            variant="text"
            onPress={() => setView({ kind: 'manage' })}
          />
        </>
      ) : null}

      {view.kind === 'new' ? (
        <ContactForm
          initial={{ name: '', email: query.includes('@') ? query.trim() : '', organization: '' }}
          submitLabel={online ? 'Save and add' : 'Add to this envelope'}
          note={
            online
              ? null
              : 'You’re offline. The person is added to this envelope; save the contact later.'
          }
          onCancel={() => setView({ kind: 'list' })}
          onSubmit={async (input) => {
            if (online) {
              try {
                await api.create(input);
                await qc.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
              } catch (e) {
                // contact_exists: the person is saved already; adding them is still right.
                if (!(isApiError(e) && e.status === 409)) throw e;
              }
            }
            pick({ name: input.name.trim(), email: input.email.trim() });
          }}
        />
      ) : null}

      {view.kind === 'manage' ? (
        <ManageContacts
          contacts={(contacts.data ?? []).filter((c) => c.source === 'saved')}
          online={online}
          onEdit={(c) => setView({ kind: 'edit', contact: c })}
          onDelete={async (c) => {
            if (c.id) await api.remove(c.id);
            await qc.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
          }}
          onBack={() => setView({ kind: 'list' })}
        />
      ) : null}

      {view.kind === 'edit' ? (
        <ContactForm
          initial={{
            name: view.contact.name,
            email: view.contact.email,
            organization: view.contact.organization ?? '',
          }}
          submitLabel="Save"
          note={online ? null : 'Connect to the internet to save changes.'}
          disabled={!online}
          onCancel={() => setView({ kind: 'manage' })}
          onSubmit={async (input) => {
            if (view.contact.id) await api.update(view.contact.id, input);
            await qc.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
            setView({ kind: 'manage' });
          }}
        />
      ) : null}
    </Sheet>
  );
}

const CONTACT_ERRORS: Record<string, string> = {
  invalid_contact_name: 'Enter a name of at most 200 characters.',
  invalid_contact_email: 'Enter a valid email address.',
  invalid_contact_organization: 'The organization can be at most 200 characters.',
  contact_exists: 'You already have a contact with this email.',
  empty_contact_update: 'Change something to save.',
};

function ContactForm({
  initial,
  submitLabel,
  note,
  disabled,
  onCancel,
  onSubmit,
}: {
  readonly initial: { name: string; email: string; organization: string };
  readonly submitLabel: string;
  readonly note: string | null;
  readonly disabled?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (input: ContactInput) => Promise<void>;
}) {
  const t = useTheme();
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [organization, setOrganization] = useState(initial.organization);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: onSubmit,
    onError: (e) =>
      setError(
        isApiError(e)
          ? (CONTACT_ERRORS[e.reason] ?? 'The contact couldn’t be saved. Try again.')
          : 'The contact couldn’t be saved. Try again.',
      ),
  });
  const submit = () => {
    const input = { name, email, organization: organization.trim() || null };
    const invalid = contactInputError(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    save.mutate(input);
  };
  return (
    <View style={styles.form}>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        autoComplete="name"
        textContentType="name"
      />
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
      />
      <TextField
        label="Organization"
        hint="(optional)"
        value={organization}
        onChangeText={setOrganization}
      />
      {note ? <Text style={{ color: t.color.textSecondary, fontSize: 14 }}>{note}</Text> : null}
      <ErrorText>{error}</ErrorText>
      <Button title={submitLabel} onPress={submit} busy={save.isPending} disabled={disabled} />
      <Button title="Cancel" variant="text" onPress={onCancel} />
    </View>
  );
}

function ManageContacts({
  contacts,
  online,
  onEdit,
  onDelete,
  onBack,
}: {
  readonly contacts: readonly Contact[];
  readonly online: boolean;
  readonly onEdit: (c: Contact) => void;
  readonly onDelete: (c: Contact) => Promise<void>;
  readonly onBack: () => void;
}) {
  const t = useTheme();
  const [confirm, setConfirm] = useState<string | null>(null);
  const remove = useMutation({ mutationFn: onDelete, onSettled: () => setConfirm(null) });
  return (
    <View style={styles.form}>
      {!online ? (
        <Text style={{ color: t.color.textSecondary }}>
          Connect to the internet to change contacts.
        </Text>
      ) : null}
      {contacts.length === 0 ? (
        <Text style={{ color: t.color.textSecondary }}>You have no saved contacts yet.</Text>
      ) : null}
      <View
        style={[styles.list, { backgroundColor: t.color.surface, borderRadius: t.size.cardRadius }]}
      >
        {contacts.map((c, i) => (
          <View
            key={c.id ?? c.email}
            style={[
              styles.manageRow,
              i < contacts.length - 1
                ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator }
                : null,
            ]}
          >
            <View style={styles.manageText}>
              <Text
                style={{ color: t.color.text, fontSize: 16, fontWeight: '600' }}
                numberOfLines={1}
              >
                {c.name}
              </Text>
              <Text style={{ color: t.color.textSecondary, fontSize: 13 }} numberOfLines={1}>
                {c.email}
              </Text>
            </View>
            {confirm === c.id ? (
              <Button
                title="Delete"
                variant="destructive"
                busy={remove.isPending}
                accessibilityLabel={`Confirm delete ${c.name}`}
                onPress={() => remove.mutate(c)}
              />
            ) : (
              <>
                <Button
                  title="Edit"
                  variant="text"
                  disabled={!online}
                  accessibilityLabel={`Edit ${c.name}`}
                  onPress={() => onEdit(c)}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${c.name}`}
                  disabled={!online}
                  onPress={() => setConfirm(c.id)}
                  style={[
                    styles.iconButton,
                    {
                      minWidth: t.size.minTouch,
                      minHeight: t.size.minTouch,
                      opacity: online ? 1 : 0.42,
                    },
                  ]}
                >
                  <Text style={{ color: t.color.destructive, fontSize: 15 }}>Delete</Text>
                </Pressable>
              </>
            )}
          </View>
        ))}
      </View>
      <Button title="Done" variant="text" onPress={onBack} />
    </View>
  );
}

const styles = StyleSheet.create({
  list: { overflow: 'hidden' },
  added: { opacity: 0.5 },
  empty: { padding: 16, fontSize: 15 },
  form: { gap: 12 },
  manageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  manageText: { flex: 1, minWidth: 0 },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
});
