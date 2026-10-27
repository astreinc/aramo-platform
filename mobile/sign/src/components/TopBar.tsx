// Shared top bar for the Home and Agreements tabs (M-A4 §1.2; handoff §2A "Top bar"):
//   ☰ (opens the side menu) · search pill · "Needs my signature" badge button.
// The badge counts ONLY inbox items the server marks `can_sign` (M-A2), never an email
// match. Search: with `search` the pill is the live search field (Agreements); without
// it the pill is a button that switches to Agreements and asks it to focus its search
// (features/shell/searchFocus.ts).
import { useNavigation } from '@react-navigation/native';
import type { Ref } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useInbox } from '../features/inbox/queries';
import { ShellIcon } from '../features/shell/icons';
import { requestSearchFocus } from '../features/shell/searchFocus';
import { useShell } from '../features/shell/ShellProvider';
import { badgeText, needsSignatureCount } from '../features/shell/shellModel';
import { useTheme } from '../theme';

export interface TopBarSearch {
  readonly value: string;
  readonly onChangeText: (q: string) => void;
}

const SIZE = 44;

export function TopBar({
  search,
  searchInputRef,
}: {
  readonly search?: TopBarSearch;
  /** The live search field (with `search`), e.g. to focus it. */
  readonly searchInputRef?: Ref<TextInput>;
}) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const navigation = useNavigation();
  const { openMenu } = useShell();
  const inbox = useInbox();
  const count = needsSignatureCount(inbox.data);
  const badge = badgeText(count);
  const size = Math.max(SIZE, t.size.minTouch);

  const surface = [
    { backgroundColor: t.color.white },
    ios
      ? styles.iosShadow
      : { borderWidth: 1, borderColor: t.color.surfaceBorder ?? t.color.separator },
  ];

  function openSearch(): void {
    requestSearchFocus();
    navigation.navigate('Main', { screen: 'Agreements' });
  }

  return (
    <View style={styles.row} testID="top-bar">
      <Pressable
        testID="top-bar-menu"
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel="Menu"
        style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }, surface]}
      >
        <ShellIcon name="menu" size={22} color={t.color.text} />
      </Pressable>

      {search ? (
        <View style={[styles.pill, { height: size, borderRadius: size / 2 }, surface]}>
          <ShellIcon name="search" size={18} color={t.color.textSecondary} />
          <TextInput
            ref={searchInputRef}
            testID="agreements-search"
            value={search.value}
            onChangeText={search.onChangeText}
            placeholder="Search agreements"
            placeholderTextColor={t.color.textSecondary}
            accessibilityLabel="Search agreements"
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[styles.input, { color: t.color.text, fontFamily: t.font.family }]}
          />
        </View>
      ) : (
        <Pressable
          testID="top-bar-search"
          onPress={openSearch}
          accessibilityRole="search"
          accessibilityLabel="Search agreements"
          accessibilityHint="Opens Agreements"
          style={[styles.pill, { height: size, borderRadius: size / 2 }, surface]}
        >
          <ShellIcon name="search" size={18} color={t.color.textSecondary} />
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: t.color.textSecondary,
              fontSize: 16,
              fontFamily: t.font.family,
            }}
          >
            Search agreements
          </Text>
        </Pressable>
      )}

      <Pressable
        testID="top-bar-needs"
        onPress={() =>
          navigation.navigate('Main', { screen: 'Agreements', params: { filter: 'needs_me' } })
        }
        accessibilityRole="button"
        accessibilityLabel={
          count === 0
            ? 'Needs my signature, nothing to sign'
            : `Needs my signature, ${count} to sign`
        }
        style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }, surface]}
      >
        <ShellIcon name="needs" size={22} color={t.color.text} />
        {badge ? (
          <View
            testID="top-bar-needs-badge"
            style={[styles.badge, { backgroundColor: t.color.accent }]}
          >
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
  },
  circle: { alignItems: 'center', justifyContent: 'center' },
  iosShadow: {
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  pill: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  input: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: 0 },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
});
