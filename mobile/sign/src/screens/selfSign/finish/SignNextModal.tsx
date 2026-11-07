// M-A14 §1 item 8 (a17) — after Done, on the Agreements tab: "Want to sign another
// document?" for the first inbox item the user can sign now (GET /v1/sign/inbox). Renders
// nothing when there is none, while the inbox is being re-read, or when not visible.
import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useInbox } from '../../../features/inbox/queries';
import type { InboxItem } from '../../../features/inbox/types';
import { useTheme } from '../../../theme';
import { INK, OUTLINE_SOFT } from './art';
import { firstSignable, sentLabel } from './signNext';
import { FilledButton, OutlinedButton } from './ui';

export interface SignNextModalProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onSignNext: (item: InboxItem) => void;
}

export function SignNextModal({ visible, onClose, onSignNext }: SignNextModalProps) {
  const t = useTheme();
  const inbox = useInbox();
  const { refetch } = inbox;
  // The persisted list may be stale: re-read it each time the modal is asked for.
  useEffect(() => {
    if (visible) void refetch();
  }, [visible, refetch]);

  const item = firstSignable(inbox.data);
  if (!visible || inbox.isFetching || !item) return null;

  const sent = sentLabel(item.sent_at);
  const font = { fontFamily: t.font.family };
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
        />
        <View testID="sign-next-modal" style={styles.card} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={[styles.title, font]}>
            Want to sign another document?
          </Text>
          <Text testID="sign-next-title" style={[styles.doc, font]}>
            {item.subject}
          </Text>
          {item.from ? (
            <Text testID="sign-next-from" style={[styles.meta, styles.from, font]}>
              From: {item.from}
            </Text>
          ) : null}
          {sent ? (
            <Text testID="sign-next-sent" style={[styles.meta, styles.sent, font]}>
              Sent: {sent}
            </Text>
          ) : null}
          <View style={styles.noThanks}>
            <OutlinedButton
              testID="sign-next-no"
              title="No thanks"
              borderColor={OUTLINE_SOFT}
              radius={4}
              fontSize={17}
              onPress={onClose}
            />
          </View>
          <View style={styles.signNext}>
            <FilledButton testID="sign-next-go" title="Sign Next" onPress={() => onSignNext(item)} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(40,40,48,0.3)',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 32,
    paddingTop: 34,
    paddingHorizontal: 30,
    paddingBottom: 26,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 20 },
    elevation: 16,
  },
  title: { color: INK, fontSize: 25, fontWeight: '700', lineHeight: 32.5 },
  doc: { color: INK, fontSize: 16, fontWeight: '500', marginTop: 22 },
  meta: { color: INK, fontSize: 14.5 },
  from: { marginTop: 14 },
  sent: { marginTop: 8 },
  noThanks: { marginTop: 30 },
  signNext: { marginTop: 16 },
});
