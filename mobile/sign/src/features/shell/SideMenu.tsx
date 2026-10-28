// Side menu (M-A4 §1.4; handoff §2A "Side menu"): a panel sliding in from the left over a
// scrim. Profile card (name, email, organization from GET /v1/sign/sender/context), the
// saved signature (GET /v1/sign/me/signature; initials stay under Account) with a link to manage it,
// Account · Templates (only while sign.templates is available) · Notifications (server
// unread count) · Settings, and Log out pinned at the bottom. No account switcher (A7).
//
// Accessibility: a Modal keeps VoiceOver / TalkBack inside the panel (focus trap), the
// Android back button and the iOS escape gesture close it, and every target is >= 44/48.
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Alert,
  Animated,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices } from '../../app/ServicesContext';
import { useSenderContext } from '../inbox/queries';
import { useUnreadCount } from '../notifications/queries';
import { loadSavedMarks, type SavedMark } from '../signing/adopt';
import { useReducedMotion } from '../signing/useReducedMotion';
import { useTheme } from '../../theme';
import { ShellIcon, type ShellIconName } from './icons';
import {
  initialsFor,
  menuItems,
  profileLines,
  type MenuItem,
  type MenuItemKey,
} from './shellModel';

/** Same key as the Account screen, so saving a default there refreshes the menu. */
export const SAVED_MARKS_KEY = ['sign', 'me', 'signature'] as const;

const ITEM_ICON: Record<MenuItemKey, ShellIconName> = {
  account: 'account',
  templates: 'templates',
  notifications: 'notifications',
  settings: 'settings',
};

const SCRIM = 'rgba(0,0,0,0.32)';
const DURATION_MS = 220;

function MarkImage({ mark, height }: { readonly mark: SavedMark; readonly height: number }) {
  if (!/^data:image\/(png|jpeg);base64,/.test(mark.image_data_url)) return null;
  return (
    <Image
      source={{ uri: mark.image_data_url }}
      resizeMode="contain"
      // Shrinks (ink stays proportional) so the preview never runs under "Change".
      style={{ height, width: height * 4, flexShrink: 1, minWidth: 0 }}
      accessibilityIgnoresInvertColors
    />
  );
}

export function SideMenu({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.round(width * 0.84);
  const reduced = useReducedMotion();
  const navigation = useNavigation();
  const { workspace, signOut } = useServices();
  const ctx = useSenderContext();
  const unread = useUnreadCount().data ?? 0;
  const saved = useQuery({
    queryKey: SAVED_MARKS_KEY,
    queryFn: () => loadSavedMarks(workspace),
    enabled: open,
  });

  // Keep the Modal mounted while the close animation runs.
  const [mounted, setMounted] = useState(open);
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduced ? 0 : DURATION_MS,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => anim.stop();
  }, [open, reduced, progress]);

  const profile = profileLines(ctx.data);
  const items = menuItems({ context: ctx.data, unread });
  const signature = saved.data?.signature ?? null;
  // The menu previews the signature only; initials are managed under Account.
  const hasMark = signature !== null;

  function go(route: MenuItem['route']): void {
    onClose();
    if (route.name === 'Account') navigation.navigate('Account', route.params);
    else if (route.name === 'Templates') navigation.navigate('Templates');
    else navigation.navigate('Notifications');
  }

  function logOut(): void {
    onClose();
    // Present after the panel's Modal has gone (iOS refuses to present over a dismissing one).
    setTimeout(confirmLogOut, (reduced ? 0 : DURATION_MS) + 60);
  }

  function confirmLogOut(): void {
    Alert.alert('Log out?', 'You’ll need to sign in again to see your agreements.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  const cardBorder = ios ? '#E5E5EA' : (t.color.surfaceBorder ?? t.color.separator);
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] });

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM, opacity: progress }]}
      >
        <Pressable
          testID="side-menu-scrim"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          accessible={false}
          importantForAccessibility="no"
        />
      </Animated.View>
      <Animated.View
        testID="side-menu"
        accessibilityViewIsModal
        accessibilityLabel="Menu"
        onAccessibilityEscape={onClose}
        style={[
          styles.panel,
          {
            width: panelWidth,
            backgroundColor: t.color.surface,
            paddingTop: insets.top + 12,
            paddingBottom: insets.bottom + 12,
            transform: [{ translateX }],
          },
        ]}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} bounces={false}>
          <Pressable
            testID="side-menu-close"
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            style={[
              styles.close,
              { backgroundColor: t.color.fill, width: t.size.minTouch, height: t.size.minTouch },
            ]}
          >
            <ShellIcon name="close" size={22} color={t.color.text} />
          </Pressable>

          <View style={[styles.card, { borderColor: cardBorder }]}>
            <Pressable
              testID="side-menu-profile"
              onPress={() => go({ name: 'Account' })}
              accessibilityRole="button"
              accessibilityLabel={[profile.name, profile.email, profile.organization]
                .filter(Boolean)
                .join(', ')}
              accessibilityHint="Opens Account"
              style={styles.profile}
            >
              <View style={[styles.avatar, { backgroundColor: t.color.tint }]}>
                <Text style={{ color: t.color.onTint, fontSize: 17, fontWeight: '600' }}>
                  {initialsFor(profile.name)}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: t.color.text,
                    fontSize: 17,
                    fontWeight: '600',
                    fontFamily: t.font.family,
                  }}
                >
                  {profile.name}
                </Text>
                {profile.email ? (
                  <Text numberOfLines={1} style={[styles.meta, { color: t.color.textSecondary }]}>
                    {profile.email}
                  </Text>
                ) : null}
                {profile.organization ? (
                  <Text
                    testID="side-menu-org"
                    numberOfLines={1}
                    style={[styles.meta, { color: t.color.textSecondary, fontSize: 12.5 }]}
                  >
                    {profile.organization}
                  </Text>
                ) : null}
              </View>
              <ShellIcon
                name="chevronRight"
                size={18}
                color={t.color.textTertiary}
                strokeWidth={2.2}
              />
            </Pressable>
            <Pressable
              testID="side-menu-signature"
              onPress={() => go({ name: 'Account', params: { section: 'settings' } })}
              accessibilityRole="button"
              accessibilityLabel={hasMark ? 'Your saved signature. Change' : 'Add your signature'}
              style={[
                styles.signature,
                {
                  borderTopColor: t.color.separator,
                  borderTopWidth: t.size.separatorWidth,
                  minHeight: t.size.minTouch + 14,
                },
              ]}
            >
              <View style={styles.marks}>
                {signature ? <MarkImage mark={signature} height={34} /> : null}
                {!hasMark ? (
                  <Text style={{ color: t.color.text, fontSize: 15, fontFamily: t.font.family }}>
                    Add your signature
                  </Text>
                ) : null}
              </View>
              <Text style={{ color: t.color.accent, fontSize: 14, fontWeight: '600' }}>
                {hasMark ? 'Change' : 'Add'}
              </Text>
            </Pressable>
          </View>

          {items.map((m) => (
            <Pressable
              key={m.key}
              testID={`side-menu-${m.key}`}
              onPress={() => go(m.route)}
              accessibilityRole="button"
              accessibilityLabel={m.badge ? `${m.label}, ${m.badge} unread` : m.label}
              android_ripple={ios ? undefined : { color: t.color.fill }}
              style={[styles.item, { minHeight: t.size.minTouch + 4 }]}
            >
              <ShellIcon name={ITEM_ICON[m.key]} color={t.color.text} strokeWidth={1.8} />
              <Text style={[styles.itemLabel, { color: t.color.text, fontFamily: t.font.family }]}>
                {m.label}
              </Text>
              {m.badge ? (
                <View style={[styles.badge, { backgroundColor: t.color.accent }]}>
                  <Text style={styles.badgeText}>{m.badge}</Text>
                </View>
              ) : null}
            </Pressable>
          ))}

          <View style={{ flex: 1 }} />
          <View
            style={{
              borderTopColor: t.color.separator,
              borderTopWidth: t.size.separatorWidth,
              paddingTop: 8,
              marginTop: 16,
            }}
          >
            <Pressable
              testID="side-menu-logout"
              onPress={logOut}
              accessibilityRole="button"
              accessibilityLabel="Log out"
              style={[styles.item, { minHeight: t.size.minTouch + 4 }]}
            >
              <ShellIcon name="logout" color={t.color.text} strokeWidth={1.8} />
              <Text style={[styles.itemLabel, { color: t.color.text, fontFamily: t.font.family }]}>
                Log out
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 8, height: 0 },
    elevation: 16,
  },
  close: {
    alignSelf: 'flex-start',
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  card: { borderWidth: 1, borderRadius: 16, overflow: 'hidden', marginBottom: 18 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { fontSize: 13.5, marginTop: 1 },
  signature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  marks: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    overflow: 'hidden',
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 6 },
  itemLabel: { flex: 1, fontSize: 18, fontWeight: '500' },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
});
