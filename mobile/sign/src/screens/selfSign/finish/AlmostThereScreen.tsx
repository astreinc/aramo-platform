// M-A14 §1 item 6 (a13) — "You're almost there", shown once the server returned COMPLETED
// (R-1). Paper plane, title, "Now, send a copy to others", Email · Share · Save (R-2, R-5)
// on the executed PDF, and an outlined Finish Signing.
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ShareTarget } from '../../../features/share/shareCompleted';
import { useTheme } from '../../../theme';
import { INK, PaperPlane, SUCCESS_TEXT } from './art';
import { bottomPad, CircleAction, OutlinedButton } from './ui';
import { useCopyActions } from './useCopyActions';

export interface AlmostThereScreenProps {
  readonly envelopeId: string;
  readonly documentTitle: string;
  readonly onFinishSigning: () => void;
}

export function sharedTimes(n: number): string {
  return `✓ Shared ${n} ${n === 1 ? 'time' : 'times'}`;
}

export function AlmostThereScreen({ envelopeId, documentTitle, onFinishSigning }: AlmostThereScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Shown only after COMPLETED (R-1), so the sender's executed copy exists.
  const target = useMemo<ShareTarget>(
    () => ({ kind: 'sent', envelopeId, subject: documentTitle }),
    [envelopeId, documentTitle],
  );
  const { busy, handedOff, run } = useCopyActions(target);
  const font = { fontFamily: t.font.family };
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: bottomPad(insets.bottom) }]}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <PaperPlane />
        <Text accessibilityRole="header" style={[styles.title, font]}>
          You&apos;re almost there
        </Text>
        <Text style={[styles.subtitle, font]}>Now, send a copy to others</Text>
        <View style={styles.actions}>
          <CircleAction
            testID="almost-email"
            icon="mail"
            label="Email"
            accessibilityLabel="Email a copy"
            busy={busy === 'email'}
            disabled={busy !== null}
            onPress={() => run('email')}
          />
          <CircleAction
            testID="almost-share"
            icon="share"
            label="Share"
            accessibilityLabel="Share a copy"
            busy={busy === 'share'}
            disabled={busy !== null}
            onPress={() => run('share')}
          />
          <CircleAction
            testID="almost-save"
            icon="save"
            label="Save"
            accessibilityLabel="Save a copy"
            busy={busy === 'save'}
            disabled={busy !== null}
            onPress={() => run('save')}
          />
        </View>
        {handedOff > 0 ? (
          <Text testID="almost-shared" style={[styles.shared, font]}>
            {sharedTimes(handedOff)}
          </Text>
        ) : null}
      </ScrollView>
      <OutlinedButton testID="almost-finish" title="Finish Signing" onPress={onFinishSigning} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF', paddingHorizontal: 24 },
  body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  title: { color: INK, fontSize: 32, fontWeight: '700', marginTop: 18, textAlign: 'center' },
  subtitle: { color: INK, fontSize: 18, fontWeight: '600', marginTop: 26, textAlign: 'center' },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    columnGap: 40,
    rowGap: 20,
    marginTop: 28,
  },
  shared: { color: SUCCESS_TEXT, fontSize: 14, marginTop: 22, textAlign: 'center' },
});
