// Step 2 "Who needs to sign?" (handoff §4.6, adapted by directive §5 and §7):
//   - up to 10 recipients, each a signer (C-11: no "Gets a copy", no CC, no per-
//     recipient auth);
//   - routing PARALLEL or SEQUENTIAL (Multi-Signer, C-1), with reorder for sequential
//     (list position is the signing order);
//   - × removes the recipient and their fields; Add recipient opens the contacts sheet.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ContactsSheet } from '../../features/contacts/ContactsSheet';
import { Segments } from '../../features/inbox/ui';
import { MAX_RECIPIENTS, type RoutingMode } from '../../features/send/draftModel';
import type { SendFlowController, SendFlowState } from '../../features/send/sendFlowController';
import { StepTitle } from '../../features/send/ui';
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

export function RecipientsStep({
  controller,
  state,
  me,
  online,
}: {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
  readonly me: { readonly name: string; readonly email: string } | null;
  readonly online: boolean;
}) {
  const t = useTheme();
  const [sheet, setSheet] = useState(false);
  const p = state.draft?.payload;
  const recipients = useMemo(() => p?.recipients ?? [], [p?.recipients]);
  const mode = p?.routingMode ?? 'PARALLEL';
  const added = useMemo(() => new Set(recipients.map((r) => r.email.toLowerCase())), [recipients]);
  const sequential = mode === 'SEQUENTIAL';
  const full = recipients.length >= MAX_RECIPIENTS;

  return (
    <View style={styles.body}>
      <StepTitle>Who needs to sign?</StepTitle>
      {recipients.length > 1 ? (
        <Segments items={ROUTING_ITEMS} value={mode} onChange={(m) => controller.setRouting(m)} testIDPrefix="routing" />
      ) : null}
      {recipients.map((r, i) => {
        const color = recipientColor(i);
        return (
          <Card key={r.key}>
            <View style={styles.card} testID={`recipient-${i}`}>
              {sequential ? (
                <Text style={[styles.order, { color: t.color.textSecondary }]} accessibilityLabel={`Signs ${i + 1}`}>
                  {i + 1}
                </Text>
              ) : null}
              <View style={[styles.dot, { backgroundColor: color }]} />
              <View style={styles.text}>
                <Text numberOfLines={1} style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }}>
                  {r.name}
                </Text>
                <Text numberOfLines={1} style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>
                  {r.email}
                </Text>
              </View>
              {sequential ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${r.name} up`}
                    disabled={i === 0}
                    onPress={() => controller.moveRecipient(r.key, -1)}
                    style={[styles.icon, { minWidth: t.size.minTouch, minHeight: t.size.minTouch, opacity: i === 0 ? 0.3 : 1 }]}
                  >
                    <Text style={{ color: t.color.accent, fontSize: 18 }}>↑</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${r.name} down`}
                    disabled={i === recipients.length - 1}
                    onPress={() => controller.moveRecipient(r.key, 1)}
                    style={[
                      styles.icon,
                      { minWidth: t.size.minTouch, minHeight: t.size.minTouch, opacity: i === recipients.length - 1 ? 0.3 : 1 },
                    ]}
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
          </Card>
        );
      })}
      <Button
        title="Add recipient"
        variant="secondary"
        disabled={full}
        accessibilityHint={full ? 'An envelope can have up to 10 signers' : undefined}
        onPress={() => setSheet(true)}
      />
      <Text style={[styles.foot, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
        {full ? `Up to ${MAX_RECIPIENTS} signers. ` : ''}
        {routingFootnote(mode)}
      </Text>
      <ContactsSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        me={me}
        addedEmails={added}
        online={online}
        onPick={(person) => controller.addRecipient(person)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, padding: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16, paddingRight: 4, paddingVertical: 8 },
  order: { width: 18, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  foot: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
