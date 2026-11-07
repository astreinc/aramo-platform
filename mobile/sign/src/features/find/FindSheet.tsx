// M-A14 §1 item 4 — the "Find in Document" sheet of Sign Document (a10): a white sheet
// above the tool sheet with "Find", ✕, the search field, "N matches · highlighted on the
// page", and the matches listed by page ("p. 1" chip, the words around the match with
// the match highlighted). The words come from the document's existing text layer
// (useFind); tapping a match closes the sheet and scrolls to it.
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../theme';
import type { FindMatch } from './findModel';
import type { FindState } from './useFind';

const INK = '#0D1B4C';
const SECONDARY = '#4A5578';
/** The prototype lists at most 8 matches; the count line gives the total. */
export const MAX_LISTED = 8;

export function FindSheet({
  find,
  bottom,
  onGo,
}: {
  readonly find: FindState;
  /** Distance from the editor's bottom (the tool sheet's height, or the keyboard). */
  readonly bottom: number;
  readonly onGo: (m: FindMatch) => void;
}) {
  const t = useTheme();
  const font = { fontFamily: t.font.family };
  return (
    <View testID="find-sheet" style={[styles.sheet, { bottom }]}>
      <View style={styles.handle} />
      <View style={styles.head}>
        <Text accessibilityRole="header" style={[styles.title, font]}>
          Find
        </Text>
        <Pressable
          testID="find-close"
          onPress={find.close}
          accessibilityRole="button"
          accessibilityLabel="Close find"
          hitSlop={8}
          style={styles.close}
        >
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M18 6 6 18M6 6l12 12" />
          </Svg>
        </Pressable>
      </View>
      <View style={styles.field}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={SECONDARY} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5" />
        </Svg>
        <TextInput
          testID="find-input"
          value={find.query}
          onChangeText={find.setQuery}
          placeholder="Find in Document"
          placeholderTextColor={SECONDARY}
          accessibilityLabel="Find in Document"
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[styles.input, font]}
        />
      </View>
      <Text testID="find-count" accessibilityLiveRegion="polite" style={[styles.count, font]}>
        {find.listStatus}
      </Text>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.list}>
        {find.matches.slice(0, MAX_LISTED).map((m, i) => {
          const s = find.snippet(m);
          return (
            <Pressable
              key={`${m.docKey}:${m.page}:${i}`}
              testID={`find-result-${i}`}
              onPress={() => onGo(m)}
              accessibilityRole="button"
              accessibilityLabel={`Page ${m.page + 1}${s ? `: ${s.pre}${s.hit}${s.post}` : ''}`}
              style={styles.row}
            >
              <Text style={[styles.chip, font]}>{`p. ${m.page + 1}`}</Text>
              <Text style={[styles.snippet, font]}>
                {s ? (
                  <>
                    {s.pre}
                    <Text style={styles.hit}>{s.hit}</Text>
                    {s.post}
                  </>
                ) : (
                  find.query
                )}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 7,
    maxHeight: '55%',
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 22,
    shadowColor: INK,
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 12,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#9A9EA8', alignSelf: 'center', marginBottom: 14 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  title: { flex: 1, fontSize: 24, fontWeight: '500', color: INK },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    borderWidth: 2,
    borderColor: INK,
    borderRadius: 4,
    paddingHorizontal: 14,
  },
  input: { flex: 1, minWidth: 0, fontSize: 18, color: INK, padding: 0 },
  count: { fontSize: 13, fontWeight: '500', color: SECONDARY, marginTop: 12, marginBottom: 4, marginHorizontal: 2 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#EEF0F4',
  },
  chip: {
    fontSize: 12,
    fontWeight: '600',
    color: '#022AC0',
    backgroundColor: '#E8EDFB',
    borderRadius: 4,
    overflow: 'hidden',
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  snippet: { flex: 1, fontSize: 14.5, lineHeight: 20, color: INK },
  hit: { backgroundColor: '#FFE58F', fontWeight: '600' },
});
