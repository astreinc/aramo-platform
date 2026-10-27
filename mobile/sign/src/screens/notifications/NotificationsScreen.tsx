// Notifications (a root-stack screen opened from the side menu, with a "‹ Home" back
// link, M-A4 §1.5; handoff §4.7; directive §8; M-A3 §1): the server feed in Today /
// Earlier, unread dots, Mark all read, tap → mark read + open. Sender items open the
// envelope detail on Activity; recipient items (inbox_item_id) open the received view.
import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { OfflineBanner } from '../../components/Banner';
import { useToast } from '../../components/Toast';
import { relativeTime } from '../../features/inbox/agreementsModel';
import { OFFLINE_ACTION_REASON, useOnline } from '../../features/inbox/queries';
import { EmptyState } from '../../features/inbox/ui';
import {
  iconFor,
  sections,
  targetFor,
  titleFor,
  type FeedIcon,
  type FeedItem,
} from '../../features/notifications/notificationModel';
import { useFeed, useMarkRead, useUnreadCount } from '../../features/notifications/queries';
import { HomeBackLink } from '../../features/shell/HomeBackLink';
import { useTheme } from '../../theme';

const ICON_PATH: Record<FeedIcon, string> = {
  signed: 'M5 12l5 5 9-10',
  viewed: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  declined: 'M6 6l12 12M18 6L6 18',
  expired: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  completed: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9 12l2 2 4-4',
  needs: 'M4 20l4-1 10-10-3-3L5 16zM14 7l3 3',
};

function FeedIconView({ icon }: { readonly icon: FeedIcon }) {
  const t = useTheme();
  const palette: Record<FeedIcon, { bg: string; fg: string }> = {
    signed: { bg: t.color.successTint, fg: t.color.success },
    viewed: { bg: t.color.tint, fg: t.color.accent },
    declined: { bg: '#FBE9E7', fg: '#B3402A' },
    expired: { bg: '#FAEFD8', fg: '#946011' },
    completed: { bg: t.color.successTint, fg: t.color.success },
    needs: { bg: t.color.accent, fg: '#FFFFFF' },
  };
  const c = palette[icon];
  return (
    <View style={[styles.icon, { backgroundColor: c.bg }]}>
      <Svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke={c.fg}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Path d={ICON_PATH[icon]} />
      </Svg>
    </View>
  );
}

export function NotificationsScreen() {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const toast = useToast();
  const online = useOnline();
  const feed = useFeed();
  const unread = useUnreadCount();
  const mark = useMarkRead();
  const [refreshing, setRefreshing] = useState(false);
  const items = (feed.data?.pages ?? []).flatMap((p) => p.items);
  const data = sections(items);
  const count = unread.data ?? 0;

  function open(item: FeedItem): void {
    if (!item.read_at && online) void mark.one(item.id).catch(() => undefined);
    const target = targetFor(item);
    if (!target) return;
    if (target.name === 'EnvelopeDetail') navigation.navigate('EnvelopeDetail', target.params);
    else navigation.navigate('ReceivedEnvelope', target.params);
  }

  async function readAll(): Promise<void> {
    try {
      await mark.all();
    } catch {
      toast.show('Couldn’t mark everything read. Try again.');
    }
  }

  const markAll = (
    <Pressable
      testID="mark-all-read"
      onPress={() => void readAll()}
      disabled={!online || count === 0}
      accessibilityRole="button"
      accessibilityLabel="Mark all read"
      accessibilityHint={online ? undefined : OFFLINE_ACTION_REASON}
      accessibilityState={{ disabled: !online || count === 0 }}
      hitSlop={10}
      style={{
        opacity: !online || count === 0 ? 0.42 : 1,
        minHeight: t.size.minTouch,
        justifyContent: 'center',
      }}
    >
      <Text
        style={{ color: t.color.accent, fontSize: ios ? 17 : 14, fontWeight: ios ? '400' : '500' }}
      >
        Mark all read
      </Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen, paddingTop: insets.top }}>
      <SectionList
        sections={data}
        keyExtractor={(i) => i.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={{ gap: 8, paddingBottom: 4 }}>
            {ios ? (
              <>
                <View style={styles.iosTop}>
                  <HomeBackLink />
                  {markAll}
                </View>
                <Text
                  accessibilityRole="header"
                  style={[styles.pad, { color: t.color.text, ...t.type.largeTitle }]}
                >
                  Notifications
                </Text>
              </>
            ) : (
              <>
                <HomeBackLink />
                <View style={styles.androidBar}>
                  <Text
                    accessibilityRole="header"
                    style={{
                      flex: 1,
                      color: t.color.text,
                      fontFamily: t.font.family,
                      ...t.type.largeTitle,
                    }}
                  >
                    Notifications
                  </Text>
                  {markAll}
                </View>
              </>
            )}
            {!online ? (
              <View style={styles.pad}>
                <OfflineBanner />
              </View>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text
            accessibilityRole="header"
            style={[styles.section, { color: t.color.textSecondary }]}
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => {
          const title = titleFor(item);
          const when = relativeTime(item.created_at);
          return (
            <Pressable
              testID={`notification-${item.id}`}
              onPress={() => open(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.read_at ? '' : 'Unread. '}${title}. ${item.envelope_subject}. ${when}`}
              android_ripple={ios ? undefined : { color: t.color.fill }}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: t.color.surface,
                  minHeight: t.size.minTouch + 20,
                  borderBottomColor: t.color.separator,
                  borderBottomWidth: t.size.separatorWidth,
                },
                pressed && ios ? { backgroundColor: t.color.fill } : null,
              ]}
            >
              <FeedIconView icon={iconFor(item.type)} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  style={{
                    color: t.color.text,
                    fontSize: 15.5,
                    fontWeight: item.read_at ? '400' : '600',
                    fontFamily: t.font.family,
                  }}
                >
                  {title}
                </Text>
                <Text numberOfLines={1} style={{ color: t.color.textSecondary, fontSize: 13 }}>
                  {item.envelope_subject}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{when}</Text>
                {item.read_at ? null : (
                  <View
                    testID={`unread-${item.id}`}
                    style={[styles.unread, { backgroundColor: t.color.accent }]}
                  />
                )}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          feed.isPending ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={t.color.accent} />
          ) : (
            <EmptyState
              title="No notifications yet"
              body="When someone signs, views or declines, it shows up here."
            />
          )
        }
        onEndReached={() => {
          if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void Promise.allSettled([feed.refetch(), unread.refetch()]).then(() =>
                setRefreshing(false),
              );
            }}
            tintColor={t.color.accent}
          />
        }
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { marginHorizontal: 16 },
  iosTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingRight: 16,
    paddingTop: 4,
  },
  androidBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 64 },
  section: {
    fontSize: 13,
    fontWeight: '600',
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  unread: { width: 9, height: 9, borderRadius: 4.5 },
});
