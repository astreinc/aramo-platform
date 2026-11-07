// M-A14 §1 item 7 (a16) — "You've Signed", only after the server returned COMPLETED (R-1).
// Green check, title, the saved-in-your-account line, the paper card (R-4: this account's
// own counts; hidden while loading or on any failure), View signed copy and View
// certificate (R-5), and an outlined Done.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Sheet } from '../../../components/Sheet';
import { useTheme } from '../../../theme';
import { CARD_BORDER, INK, LineIcon, Plant, SECONDARY, SignedCheck } from './art';
import { documentsLabel, sheetsLabel, useSigningStats, type SigningStats } from './signingStats';
import { bottomPad, FilledButton, OutlinedButton, TextAction } from './ui';

export interface YouSignedScreenProps {
  readonly envelopeId: string;
  readonly onViewSigned: () => void;
  readonly onViewCertificate: () => void;
  readonly onDone: () => void;
}

export const YS_BODY = 'The agreement will be saved in your Aramo Sign account.';
export const PAPER_INFO_TITLE = 'About these numbers';
export const PAPER_INFO_BODY =
  'These numbers count only your own documents: the documents you’ve signed with Aramo Sign and their pages. ' +
  'They don’t include anyone else’s documents or any company-wide figures.';

function PaperCard({ stats, onInfo }: { readonly stats: SigningStats; readonly onInfo: () => void }) {
  const t = useTheme();
  const font = { fontFamily: t.font.family };
  return (
    <View testID="paper-card" style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={[styles.cardHeading, font]}>You’re helping save paper</Text>
        <Pressable
          testID="paper-info"
          accessibilityRole="button"
          accessibilityLabel={PAPER_INFO_TITLE}
          onPress={onInfo}
          hitSlop={11}
          style={styles.infoButton}
        >
          <LineIcon name="info" color={INK} strokeWidth={2} />
        </Pressable>
      </View>
      <View style={styles.plant}>
        <Plant />
      </View>
      <View accessible accessibilityLabel={`${documentsLabel(stats.documentsSigned)} signed with Aramo Sign`}>
        <Text style={[styles.stat, font]}>{documentsLabel(stats.documentsSigned)}</Text>
        <Text style={[styles.statSub, font]}>signed with Aramo Sign</Text>
      </View>
      <View
        style={styles.statGap}
        accessible
        accessibilityLabel={`${sheetsLabel(stats.pagesSigned)} of paper you didn’t print`}
      >
        <Text style={[styles.stat, font]}>{sheetsLabel(stats.pagesSigned)}</Text>
        <Text style={[styles.statSub, font]}>of paper you didn’t print</Text>
      </View>
    </View>
  );
}

export function YouSignedScreen({ onViewSigned, onViewCertificate, onDone }: YouSignedScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const stats = useSigningStats();
  const [info, setInfo] = useState(false);
  const font = { fontFamily: t.font.family };
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: bottomPad(insets.bottom) }]}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <SignedCheck />
        <Text accessibilityRole="header" style={[styles.title, font]}>
          You&apos;ve Signed
        </Text>
        <Text style={[styles.lead, font]}>{YS_BODY}</Text>
        <View style={styles.spacerTop} />
        {stats.isSuccess ? <PaperCard stats={stats.data} onInfo={() => setInfo(true)} /> : null}
        <View style={styles.spacerBottom} />
        <TextAction testID="ys-view-signed" title="View signed copy" onPress={onViewSigned} />
        <TextAction testID="ys-view-certificate" title="View certificate" onPress={onViewCertificate} />
      </ScrollView>
      <View style={styles.footer}>
        <OutlinedButton testID="ys-done" title="Done" onPress={onDone} />
      </View>
      <Sheet visible={info} onClose={() => setInfo(false)} title={PAPER_INFO_TITLE}>
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetText, font]}>{PAPER_INFO_BODY}</Text>
          <FilledButton testID="paper-info-ok" title="OK" radius={6} onPress={() => setInfo(false)} />
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF', paddingHorizontal: 24 },
  body: { flexGrow: 1, alignItems: 'center', paddingTop: 33 },
  title: { color: INK, fontSize: 26, fontWeight: '700', marginTop: 21, textAlign: 'center' },
  lead: {
    color: SECONDARY,
    fontSize: 17.5,
    lineHeight: 27,
    marginTop: 20,
    textAlign: 'center',
    maxWidth: 300,
  },
  spacerTop: { flexGrow: 1, minHeight: 30 },
  spacerBottom: { flexGrow: 1, minHeight: 24 },
  card: {
    width: '100%',
    maxWidth: 304,
    borderWidth: 1.5,
    borderColor: CARD_BORDER,
    borderRadius: 6,
    paddingTop: 22,
    paddingHorizontal: 18,
    paddingBottom: 24,
    alignItems: 'center',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center' },
  cardHeading: { color: SECONDARY, fontSize: 17 },
  infoButton: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  plant: { marginTop: 18, marginBottom: 16 },
  stat: { color: INK, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  statSub: { color: SECONDARY, fontSize: 15, marginTop: 6, textAlign: 'center' },
  statGap: { marginTop: 18 },
  footer: { paddingTop: 8 },
  sheetBody: { gap: 20, paddingBottom: 8 },
  sheetText: { color: SECONDARY, fontSize: 16, lineHeight: 23 },
});
