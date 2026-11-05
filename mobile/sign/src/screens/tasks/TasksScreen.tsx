// M-A12 W1-D.1 — Tasks (prototype "Tasks"), reached from Home "Assigned tasks": Needs me
// and Upcoming, with a filter and a sort. Needs me opens signing (the INBOX ITEM id);
// Upcoming opens the received envelope.
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { OfflineBanner } from '../../components/Banner';
import { Card } from '../../components/Card';
import { mergeAgreements } from '../../features/inbox/agreementsModel';
import { useInbox, useOnline } from '../../features/inbox/queries';
import { EmptyState, Segments } from '../../features/inbox/ui';
import {
  TASK_FILTERS,
  TASK_SORTS,
  tasksModel,
  type TaskCard,
  type TaskFilter,
  type TaskSort,
} from '../../features/tasks/tasksModel';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';

export function TasksScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const inbox = useInbox();
  const online = useOnline();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [sort, setSort] = useState<TaskSort>('newest');
  const rows = useMemo(() => mergeAgreements(null, inbox.data ?? null), [inbox.data]);
  const model = useMemo(() => tasksModel(rows, filter, sort), [rows, filter, sort]);
  return (
    <TasksView
      model={model}
      filter={filter}
      sort={sort}
      online={online}
      refreshing={inbox.isRefetching}
      onRefresh={() => void inbox.refetch()}
      onFilter={setFilter}
      onSort={setSort}
      onOpen={(c) =>
        c.kind === 'needs_me'
          ? navigation.navigate('Signing', { envelopeId: c.inboxItemId })
          : navigation.navigate('ReceivedEnvelope', { inboxItemId: c.inboxItemId })
      }
    />
  );
}

export function TasksView({
  model,
  filter,
  sort,
  online,
  refreshing = false,
  onRefresh,
  onFilter,
  onSort,
  onOpen,
}: {
  readonly model: ReturnType<typeof tasksModel>;
  readonly filter: TaskFilter;
  readonly sort: TaskSort;
  readonly online: boolean;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onFilter: (f: TaskFilter) => void;
  readonly onSort: (s: TaskSort) => void;
  readonly onOpen: (c: TaskCard) => void;
}) {
  const t = useTheme();
  const sortIndex = TASK_SORTS.findIndex((s) => s.key === sort);
  const nextSort = TASK_SORTS[(sortIndex + 1) % TASK_SORTS.length]!;
  const section = (title: string, cards: readonly TaskCard[]) =>
    cards.length === 0 ? null : (
      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: t.color.textSecondary, fontSize: 13, fontWeight: '600', fontFamily: t.font.family }}>
          {title}
        </Text>
        <Card>
          {cards.map((c, i) => (
            <Pressable
              key={c.key}
              testID={`task-${c.inboxItemId}`}
              onPress={() => onOpen(c)}
              accessibilityRole="button"
              accessibilityLabel={[c.subject, c.subtitle, c.due].filter(Boolean).join('. ')}
              style={[styles.row, i < cards.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.separator } : null]}
            >
              <Text style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }} numberOfLines={2}>
                {c.subject}
              </Text>
              <Text style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>{c.subtitle}</Text>
              {c.due ? <Text style={{ color: t.color.textTertiary, fontSize: 13, fontFamily: t.font.family }}>{c.due}</Text> : null}
              <Text style={{ color: t.color.accent, fontSize: 15, fontWeight: '600', fontFamily: t.font.family }}>
                {c.kind === 'needs_me' ? 'Sign ›' : 'View ›'}
              </Text>
            </Pressable>
          ))}
        </Card>
      </View>
    );
  return (
    <ScrollView
      testID="tasks-screen"
      style={{ flex: 1, backgroundColor: t.color.screen }}
      contentContainerStyle={styles.body}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {!online ? <OfflineBanner /> : null}
      <Text testID="tasks-summary" style={{ color: t.color.textSecondary, fontSize: 15, fontFamily: t.font.family }}>
        {model.summary}
      </Text>
      <Segments items={TASK_FILTERS} value={filter} onChange={onFilter} testIDPrefix="tasks-filter" />
      <Pressable
        testID="tasks-sort"
        onPress={() => onSort(nextSort.key)}
        accessibilityRole="button"
        accessibilityLabel={`Sort: ${TASK_SORTS[sortIndex]?.label ?? ''}`}
        accessibilityHint={`Changes the order to ${nextSort.label}`}
        style={{ alignSelf: 'flex-end', minHeight: t.size.minTouch, justifyContent: 'center' }}
      >
        <Text style={{ color: t.color.accent, fontSize: 15, fontFamily: t.font.family }}>
          {`Sort: ${TASK_SORTS[sortIndex]?.label ?? ''}`}
        </Text>
      </Pressable>
      {model.empty ? (
        <EmptyState title="You’re all caught up" body="Nothing needs your signature right now." />
      ) : (
        <>
          {section('Needs me', model.needs)}
          {section('Upcoming', model.upcoming)}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 14, paddingBottom: 48 },
  row: { paddingHorizontal: 14, paddingVertical: 12, gap: 3 },
});
