// APP-DELETED-1 A2 (LOCKED 2026-11-27; Retention & Purge; UAT DEL-10) — the envelope purge on the
// app's envelope screen, as on Sign web:
//   - a banner while a purge is queued ("Purge scheduled: … on {date}") or after it ran (purged);
//   - "Cancel purge" while queued, when the server's actions.dequeue_purge;
//   - "Purge…" when actions.purge: choose what is purged, type PURGE, Queue purge (14-day queue).
// The wording and levels are the shared @aramo/sign-client copy; the server decides every action.
import { PURGE_COPY, PURGE_LEVELS, purgeBannerLine, purgeConfirmed, type PurgeLevel, type PurgeStateView } from '@aramo/sign-client';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useTheme } from '../../theme';

import { dateTime } from './agreementsModel';

export function PurgeBanner({
  purge,
  canCancel,
  busy,
  online,
  onCancel,
}: {
  readonly purge: PurgeStateView | null;
  readonly canCancel: boolean;
  readonly busy: boolean;
  readonly online: boolean;
  readonly onCancel: () => void;
}) {
  const t = useTheme();
  const line = purgeBannerLine(purge, dateTime);
  if (line === null) return null;
  const executed = purge?.state === 'EXECUTED';
  return (
    <View
      testID="purge-banner"
      accessibilityRole="summary"
      style={[styles.banner, { backgroundColor: executed ? t.color.surface : t.color.destructiveTint, borderColor: t.color.separator }]}
    >
      <Text style={{ color: t.color.text, fontSize: 15, lineHeight: 21, fontFamily: t.font.family }}>{line}</Text>
      {canCancel && !executed ? (
        <Button testID="cancel-purge" title={PURGE_COPY.cancel} variant="text" busy={busy} disabled={!online} onPress={onCancel} />
      ) : null}
    </View>
  );
}

export function PurgeSheet({
  visible,
  busy,
  error,
  online,
  onQueue,
  onClose,
}: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly online: boolean;
  readonly onQueue: (level: PurgeLevel) => void;
  readonly onClose: () => void;
}) {
  const t = useTheme();
  const [level, setLevel] = useState<PurgeLevel>('DOCUMENTS');
  const [typed, setTyped] = useState('');
  const text = { color: t.color.textSecondary, fontSize: 15, lineHeight: 21, fontFamily: t.font.family } as const;
  const close = () => {
    setTyped('');
    setLevel('DOCUMENTS');
    onClose();
  };
  return (
    <Sheet visible={visible} onClose={close} title={PURGE_COPY.title}>
      <View style={{ gap: 10 }} testID="purge-sheet">
        <Text style={text}>{PURGE_COPY.body}</Text>
        <Text style={[text, { color: t.color.text, fontWeight: '600' }]}>{PURGE_COPY.level_label}</Text>
        {PURGE_LEVELS.map((l) => {
          const on = l.key === level;
          return (
            <Pressable
              key={l.key}
              testID={`purge-level-${l.key}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => setLevel(l.key)}
              style={[styles.option, { borderColor: on ? t.color.accent : t.color.separator, backgroundColor: t.color.surface }]}
            >
              <Text style={{ color: t.color.text, fontSize: 16, fontWeight: on ? '700' : '500', fontFamily: t.font.family }}>{l.label}</Text>
              <Text style={[text, { fontSize: 14 }]}>{l.help}</Text>
            </Pressable>
          );
        })}
        <Text style={text}>{PURGE_COPY.confirm_label}</Text>
        <TextInput
          testID="purge-confirm-input"
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel={PURGE_COPY.confirm_label}
          style={[styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }]}
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive }}>
            {error}
          </Text>
        ) : null}
        <Button
          testID="confirm-purge"
          title={PURGE_COPY.queue}
          variant="destructive"
          busy={busy}
          disabled={!purgeConfirmed(typed) || !online}
          onPress={() => onQueue(level)}
        />
        <Button testID="purge-cancel-sheet" title="Cancel" variant="text" onPress={close} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  banner: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 6 },
  option: { borderWidth: 1.5, borderRadius: 12, padding: 12, gap: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
