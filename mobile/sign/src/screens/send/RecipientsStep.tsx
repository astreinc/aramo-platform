// Step 2 "Who needs to sign?" (handoff §4.6, adapted by directive §5 and §7; M-A4 §6.1;
// M-A5 §1, §2, §3.5, §4.1):
//   - up to 10 signing recipients and 10 copy recipients (distinct emails across all);
//   - role chips **Signs · In person · Copy** per recipient (prototype step 2), shown only
//     when FEATURES.recipientRoles is on; In person only while hosting is available
//     (FEATURES.hostedSigning + the server's `features.in_person_signing`). Copy shows
//     its timing: When sent / After completion / Both;
//   - routing PARALLEL or SEQUENTIAL (Multi-Signer, C-1), with reorder for sequential
//     among the signing recipients; copy recipients are listed apart, under "Receives a
//     copy", and never take part in the order;
//   - × removes the recipient and their fields; Add recipient opens the contacts sheet;
//     "Add someone signing in person" takes a name and an optional email (§3.5);
//   - **Assign to me** adds the signed-in user as a signer bound to them (the server
//     binds only when the email is their verified account email), refusing a duplicate
//     with the same email check every recipient goes through.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { FEATURES } from '../../config/features';
import { ContactsSheet, type PickResult } from '../../features/contacts/ContactsSheet';
import { Segments } from '../../features/inbox/ui';
import {
  MAX_COPY_RECIPIENTS,
  MAX_RECIPIENTS,
  type DraftRecipient,
  type RecipientKind,
  type RoutingMode,
} from '../../features/send/draftModel';
import {
  COPY_TIMING,
  copyRecipients,
  isInPerson,
  kindOf,
  ROLE_CHIPS,
  ROLE_COPY,
  signingRecipients,
} from '../../features/send/recipientRoles';
import type {
  AddOutcome,
  SendFlowController,
  SendFlowState,
} from '../../features/send/sendFlowController';
import { StepTitle, TextField } from '../../features/send/ui';
import { recipientColor, useTheme } from '../../theme';

export const ROUTING_ITEMS: readonly { readonly key: RoutingMode; readonly label: string }[] = [
  { key: 'PARALLEL', label: 'Any order' },
  { key: 'SEQUENTIAL', label: 'In order' },
];

/** The footnote under the list. C-1: the "same time" copy is for parallel envelopes only. */
export function routingFootnote(mode: RoutingMode): string {
  return mode === 'SEQUENTIAL'
    ? 'People sign one after another, in this order. Each person is emailed when it’s their turn.'
    : 'Everyone signs at the same time.';
}

export const ALREADY_RECIPIENT = 'You’re already a recipient.';
export const RECIPIENTS_FULL = `An envelope can have up to ${MAX_RECIPIENTS} signers.`;
export const IN_PERSON_NOTE = 'Signs on this device with you. No signing email is sent.';

/** The message for an add outcome, or null when added. */
export function addOutcomeCopy(out: AddOutcome): string | null {
  switch (out) {
    case 'added':
      return null;
    case 'duplicate':
      return ROLE_COPY.duplicate;
    case 'signers_full':
      return RECIPIENTS_FULL;
    case 'copies_full':
      return ROLE_COPY.copies_full;
    case 'email_required':
      return ROLE_COPY.email_required;
    case 'invalid':
      return 'Enter a name, and a valid email address if you add one.';
  }
}

/** Add the signed-in user as a signer assigned to them. Returns the message to show, or null. */
export function assignToMe(
  controller: Pick<SendFlowController, 'addRecipient'>,
  me: { readonly name: string; readonly email: string },
): string | null {
  const out = controller.addRecipient(
    { name: me.name, email: me.email },
    'SIGNER',
    { assignToMe: true },
  );
  return out === 'duplicate' ? ALREADY_RECIPIENT : addOutcomeCopy(out);
}

/** The contacts sheet's result for an add outcome. */
function pickResult(out: AddOutcome): PickResult {
  return out === 'added' ? 'added' : out === 'duplicate' ? 'duplicate' : 'full';
}

function RoleChips({
  r,
  kinds,
  onPick,
}: {
  readonly r: DraftRecipient;
  readonly kinds: readonly RecipientKind[];
  readonly onPick: (k: RecipientKind) => void;
}) {
  const t = useTheme();
  const current = kindOf(r);
  return (
    <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={`Role for ${r.name}`}>
      {ROLE_CHIPS.filter((c) => kinds.includes(c.kind)).map((c) => {
        const on = c.kind === current;
        return (
          <Pressable
            key={c.kind}
            testID={`role-${r.key}-${c.kind}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${c.label}, ${r.name}`}
            onPress={() => onPick(c.kind)}
            style={[
              styles.chip,
              {
                minHeight: t.size.minTouch,
                borderRadius: t.platform === 'ios' ? 9 : 8,
                borderWidth: on ? 1.5 : 1,
                borderColor: on ? t.color.accent : t.color.separator,
                backgroundColor: on ? t.color.tint : 'transparent',
              },
            ]}
          >
            <Text
              style={{
                color: on ? t.color.onTint : t.color.text,
                fontSize: 14,
                fontWeight: '500',
                fontFamily: t.font.family,
              }}
            >
              {on ? `✓ ${c.label}` : c.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function InPersonForm({
  onAdd,
  onCancel,
}: {
  readonly onAdd: (name: string, email: string) => string | null;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={styles.form}>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        testID="in-person-name"
      />
      <TextField
        label="Email"
        hint="(optional)"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        error={error}
        testID="in-person-email"
        accessibilityHint="If you add one, the signed copy is sent there"
      />
      <View style={styles.formRow}>
        <Button title="Cancel" variant="text" onPress={onCancel} />
        <Button
          title="Add"
          testID="in-person-add"
          disabled={name.trim().length === 0}
          onPress={() => setError(onAdd(name, email))}
        />
      </View>
    </Card>
  );
}

export function RecipientsStep({
  controller,
  state,
  me,
  online,
  roles = FEATURES.recipientRoles,
  inPerson = false,
}: {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
  readonly me: { readonly name: string; readonly email: string } | null;
  readonly online: boolean;
  /** Role chips Signs · In person · Copy (FEATURES.recipientRoles). */
  readonly roles?: boolean;
  /** Hosting is available (FEATURES.hostedSigning + the server's in_person_signing). */
  readonly inPerson?: boolean;
}) {
  const t = useTheme();
  const [sheet, setSheet] = useState(false);
  const [inPersonForm, setInPersonForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const p = state.draft?.payload;
  const recipients = useMemo(() => p?.recipients ?? [], [p?.recipients]);
  const signing = signingRecipients(recipients);
  const copies = copyRecipients(recipients);
  const mode = p?.routingMode ?? 'PARALLEL';
  const added = useMemo(
    () => new Set(recipients.map((r) => r.email.toLowerCase()).filter((e) => e.length > 0)),
    [recipients],
  );
  const sequential = mode === 'SEQUENTIAL';
  const signersFull = signing.length >= MAX_RECIPIENTS;
  const copiesFull = copies.length >= MAX_COPY_RECIPIENTS;
  // With the role chips, a contact picked while the signers are full joins as a copy.
  const pickKind: RecipientKind = roles && signersFull ? 'RECEIVES_COPY' : 'SIGNER';
  const full = signersFull && (!roles || copiesFull);
  const kinds: RecipientKind[] = roles
    ? inPerson
      ? ['SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY']
      : ['SIGNER', 'RECEIVES_COPY']
    : [];

  const setKind = (key: string, k: RecipientKind) => setNotice(controller.setRecipientKind(key, k));

  function card(r: DraftRecipient, i: number, signingIndex: number | null) {
    const copy = signingIndex === null;
    const color = copy ? t.color.textTertiary : recipientColor(signingIndex);
    const last = signingIndex === signing.length - 1;
    const emailLine = r.email
      ? r.email
      : isInPerson(r)
        ? 'No email · signs on this device'
        : '';
    return (
      <Card key={r.key}>
        <View testID={`recipient-${i}`}>
          <View style={styles.card}>
            {sequential && !copy ? (
              <Text style={[styles.order, { color: t.color.textSecondary }]} accessibilityLabel={`Signs ${signingIndex + 1}`}>
                {signingIndex + 1}
              </Text>
            ) : null}
            <View style={[styles.dot, { backgroundColor: color }]} />
            <View style={styles.text}>
              <Text numberOfLines={1} style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }}>
                {r.name}
                {r.assignToMe ? ' (you)' : ''}
              </Text>
              {emailLine ? (
                <Text numberOfLines={1} style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>
                  {emailLine}
                </Text>
              ) : null}
            </View>
            {sequential && !copy ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${r.name} up`}
                  disabled={signingIndex === 0}
                  onPress={() => controller.moveRecipient(r.key, -1)}
                  style={[styles.icon, { minWidth: t.size.minTouch, minHeight: t.size.minTouch, opacity: signingIndex === 0 ? 0.3 : 1 }]}
                >
                  <Text style={{ color: t.color.accent, fontSize: 18 }}>↑</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${r.name} down`}
                  disabled={last}
                  onPress={() => controller.moveRecipient(r.key, 1)}
                  style={[styles.icon, { minWidth: t.size.minTouch, minHeight: t.size.minTouch, opacity: last ? 0.3 : 1 }]}
                >
                  <Text style={{ color: t.color.accent, fontSize: 18 }}>↓</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${r.name}`}
              accessibilityHint="Also removes their fields"
              onPress={() => controller.removeRecipient(r.key)}
              style={[styles.icon, { minWidth: t.size.minTouch, minHeight: t.size.minTouch }]}
            >
              <Text style={{ color: t.color.textSecondary, fontSize: 20 }}>×</Text>
            </Pressable>
          </View>
          {kinds.length > 0 ? (
            <View style={styles.extra}>
              <RoleChips r={r} kinds={kinds} onPick={(k) => setKind(r.key, k)} />
              {copy ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
                    Send the copy
                  </Text>
                  <Segments
                    items={COPY_TIMING}
                    value={r.copyDelivery ?? 'ON_COMPLETION'}
                    onChange={(d) => controller.setCopyDelivery(r.key, d)}
                    testIDPrefix={`timing-${r.key}`}
                  />
                </View>
              ) : null}
              {isInPerson(r) ? (
                <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
                  {IN_PERSON_NOTE}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Card>
    );
  }

  return (
    <View style={styles.body}>
      <StepTitle>Who needs to sign?</StepTitle>
      {signing.length > 1 ? (
        <Segments items={ROUTING_ITEMS} value={mode} onChange={(m) => controller.setRouting(m)} testIDPrefix="routing" />
      ) : null}
      {signing.map((r, i) => card(r, i, i))}
      {copies.length > 0 ? (
        <>
          <Text
            accessibilityRole="header"
            style={[styles.group, { color: t.color.textSecondary, fontFamily: t.font.family }]}
          >
            Receives a copy
          </Text>
          {copies.map((r, i) => card(r, signing.length + i, null))}
        </>
      ) : null}
      <Button
        title="Add recipient"
        variant="secondary"
        disabled={full}
        accessibilityHint={full ? RECIPIENTS_FULL : undefined}
        onPress={() => setSheet(true)}
      />
      {roles && inPerson && !signersFull ? (
        inPersonForm ? (
          <InPersonForm
            onCancel={() => setInPersonForm(false)}
            onAdd={(name, email) => {
              const msg = addOutcomeCopy(
                controller.addRecipient({ name, email }, 'IN_PERSON_SIGNER'),
              );
              if (msg === null) setInPersonForm(false);
              return msg;
            }}
          />
        ) : (
          <Button
            title="Add someone signing in person"
            variant="text"
            testID="add-in-person"
            accessibilityHint="A name is enough. They sign on this device with you."
            onPress={() => setInPersonForm(true)}
          />
        )
      ) : null}
      {me ? (
        <Button
          title="Assign to me"
          variant="text"
          accessibilityHint="Adds you as a signer"
          style={styles.assign}
          testID="assign-to-me"
          onPress={() => setNotice(assignToMe(controller, me))}
        />
      ) : null}
      {notice ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[styles.foot, { color: t.color.textSecondary, fontFamily: t.font.family }]}
        >
          {notice}
        </Text>
      ) : null}
      <Text style={[styles.foot, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
        {signersFull ? `Up to ${MAX_RECIPIENTS} signers. ` : ''}
        {routingFootnote(mode)}
        {copies.length > 0 ? ' People who receive a copy aren’t part of the signing order.' : ''}
      </Text>
      <ContactsSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        me={me}
        addedEmails={added}
        online={online}
        onPick={(person) => pickResult(controller.addRecipient(person, pickKind))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, padding: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16, paddingRight: 4, paddingVertical: 8 },
  extra: { gap: 10, paddingHorizontal: 16, paddingBottom: 14 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  order: { width: 18, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  assign: { alignSelf: 'flex-end' },
  group: { fontSize: 13, fontWeight: '600', marginHorizontal: 4, marginTop: 4 },
  form: { padding: 14, gap: 10 },
  formRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  foot: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
