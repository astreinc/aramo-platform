// "Use" on a template with signing roles (Amendment M-A6 §3.5; M-A4 §6.4). The prototype
// shows each template role as a slot ("{role}" over "Choose a person"); because the
// backend binds roles when the draft is created, the slots are filled here, before the
// from-template call, instead of in step 2:
//   - the template's sender values (as for a template without roles);
//   - one card per role in role order: its label and kind (Signer / Gets a copy), the
//     person bound to it, "Choose a person" (the contacts sheet) and, for a SIGNER role,
//     "Assign to me" (the signed-in user's name and email; the from-template route takes
//     no assign_to_me flag). CC roles are optional;
//   - the routing mode from the template, editable when it has 2+ signer roles (the
//     route accepts routing_mode);
//   - the message, prefilled from the template's default message.
// Problems the server would refuse are shown first (roleBindingModel); whatever the server
// still refuses is shown with its reason, and template_roles_changed reloads the list.
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { newIdempotencyKey } from '../../api/workspaceClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useTheme } from '../../theme';
import { ContactsSheet } from '../contacts/ContactsSheet';
import { useOnline, useSenderContext } from '../inbox/queries';
import { Segments } from '../inbox/ui';
import { MESSAGE_MAX, type RoutingMode } from '../send/draftModel';
import type { RoleBindingRequest, SenderTemplate, TemplateSigning } from '../send/templates';
import { ErrorText, TextField } from '../send/ui';
import {
  ALREADY_BOUND,
  ROLE_KIND_LABEL,
  assignMe,
  bindPerson,
  clearRole,
  initialRoleBinding,
  issueText,
  roleBindingIssues,
  roleBindingRequest,
  roleRefusal,
  routingEditable,
  setMessage,
  setRouting,
} from './roleBindingModel';

export const ROLE_ROUTING_ITEMS: readonly { readonly key: RoutingMode; readonly label: string }[] = [
  { key: 'PARALLEL', label: 'Any order' },
  { key: 'SEQUENTIAL', label: 'In order' },
];

export function RoleBindingForm({
  template,
  signing,
  onCreate,
  onCancel,
  onRolesChanged,
  cancelTitle = 'Cancel',
}: {
  readonly template: SenderTemplate;
  readonly signing: TemplateSigning;
  readonly onCreate: (
    values: Record<string, string>,
    idempotencyKey: string,
    binding: RoleBindingRequest,
  ) => Promise<void>;
  readonly onCancel: () => void;
  /** The server says the template's roles changed: reload the template list. */
  readonly onRolesChanged: () => void;
  readonly cancelTitle?: string;
}) {
  const t = useTheme();
  const context = useSenderContext();
  const online = useOnline();
  const user = context.data?.user;
  const me = user?.email ? { name: user.display_name || user.email, email: user.email } : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState(() => initialRoleBinding(signing));
  const [picking, setPicking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // One key per pick, reused when the sender retries (the render is idempotent on it).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const issues = useMemo(() => roleBindingIssues(signing, state), [signing, state]);

  const create = useMutation({
    mutationFn: (binding: RoleBindingRequest) => onCreate(values, idempotencyKey, binding),
    onError: (e) => {
      if (roleRefusal(e).refreshList) onRolesChanged();
    },
  });

  const submit = () => {
    setTried(true);
    setNotice(null);
    const binding = roleBindingRequest(signing, state);
    if (binding) create.mutate(binding);
  };

  const otherEmails = useMemo(
    () =>
      new Set(
        Object.entries(state.people)
          .filter(([k, p]) => k !== picking && p !== null)
          .map(([, p]) => p!.email.toLowerCase()),
      ),
    [state.people, picking],
  );

  const muted = { color: t.color.textSecondary, fontFamily: t.font.family };
  return (
    <>
      {template.senderVariables.map((v) => (
        <TextField
          key={v.key}
          label={v.label}
          value={values[v.key] ?? ''}
          onChangeText={(x) => setValues((s) => ({ ...s, [v.key]: x }))}
        />
      ))}
      <Text accessibilityRole="header" style={[styles.section, muted]}>
        Who fills each role?
      </Text>
      {signing.roles.map((role, i) => {
        const person = state.people[role.roleKey] ?? null;
        const kind = ROLE_KIND_LABEL[role.kind];
        const slot = role.kind === 'CC' ? `${role.label} · ${kind} · Optional` : `${role.label} · ${kind}`;
        return (
          <Card key={role.roleKey}>
            <View style={styles.role} testID={`role-${i}`}>
              <Text style={[styles.slot, muted]}>{slot}</Text>
              {person ? (
                <View accessible accessibilityLabel={`${role.label}: ${person.name}, ${person.email}`}>
                  <Text numberOfLines={1} style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }}>
                    {person.name}
                  </Text>
                  <Text numberOfLines={1} style={[{ fontSize: 14 }, muted]}>
                    {person.email}
                  </Text>
                </View>
              ) : null}
              <View style={styles.actions}>
                <Button
                  title={person ? 'Change' : 'Choose a person'}
                  variant="secondary"
                  accessibilityLabel={person ? `Change the person for ${role.label}` : `Choose a person for ${role.label}`}
                  testID={`role-${i}-choose`}
                  onPress={() => {
                    setNotice(null);
                    setPicking(role.roleKey);
                  }}
                />
                {role.kind === 'SIGNER' && me && !(person && person.email.toLowerCase() === me.email.toLowerCase()) ? (
                  <Button
                    title="Assign to me"
                    variant="text"
                    accessibilityLabel={`Assign ${role.label} to me`}
                    testID={`role-${i}-me`}
                    onPress={() => {
                      const out = assignMe(state, signing, role.roleKey, me);
                      setState(out.state);
                      setNotice(out.result === 'duplicate' ? ALREADY_BOUND : null);
                    }}
                  />
                ) : null}
                {person ? (
                  <Button
                    title="Remove"
                    variant="text"
                    accessibilityLabel={`Remove the person for ${role.label}`}
                    testID={`role-${i}-remove`}
                    onPress={() => setState((s) => clearRole(s, role.roleKey))}
                  />
                ) : null}
              </View>
            </View>
          </Card>
        );
      })}
      {notice ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.foot, muted]}>
          {notice}
        </Text>
      ) : null}
      {routingEditable(signing) ? (
        <Segments
          items={ROLE_ROUTING_ITEMS}
          value={state.routingMode}
          onChange={(m) => setState((s) => setRouting(s, m))}
          testIDPrefix="role-routing"
        />
      ) : null}
      <Text style={[styles.foot, muted]}>
        {state.routingMode === 'SEQUENTIAL'
          ? 'People sign one after another, in role order.'
          : 'Everyone signs at the same time.'}
      </Text>
      <TextField
        label="Message"
        hint="Optional"
        value={state.message}
        onChangeText={(m) => setState((s) => setMessage(s, m))}
        multiline
        maxLength={MESSAGE_MAX}
        style={styles.message}
      />
      {tried
        ? issues.map((issue, i) => <ErrorText key={`${issue.kind}-${i}`}>{issueText(issue)}</ErrorText>)
        : null}
      <ErrorText>{create.isError ? roleRefusal(create.error).message : null}</ErrorText>
      <Button title="Use template" busy={create.isPending} onPress={submit} testID="role-use" />
      <Button title={cancelTitle} variant="text" onPress={onCancel} />
      <ContactsSheet
        visible={picking !== null}
        onClose={() => setPicking(null)}
        me={me}
        addedEmails={otherEmails}
        online={online}
        onPick={(person) => {
          if (picking === null) return 'added';
          const out = bindPerson(state, signing, picking, person);
          if (out.result === 'duplicate') return 'duplicate';
          setState(out.state);
          return 'added';
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 4 },
  role: { gap: 6, paddingHorizontal: 16, paddingVertical: 12 },
  slot: { fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  foot: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  message: { minHeight: 96, textAlignVertical: 'top' },
});
