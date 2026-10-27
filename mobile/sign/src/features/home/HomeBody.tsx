// Home tab body (M-A4 §2; handoff §2A "Home tab"). The shell (screens/home/HomeScreen)
// renders the top bar, tab pill and + button around this. Everything here is derived
// from the queries Agreements already uses (homeModel.ts); pull to refresh refetches
// them. Cached data shows offline ("Offline · showing saved data").
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Card } from '../../components/Card';
import { OfflineBanner } from '../../components/Banner';
import { DISABLED_OPACITY, useTheme } from '../../theme';
import { AgreementRowItem } from '../inbox/AgreementRowItem';
import { mergeAgreements, type AgreementRow } from '../inbox/agreementsModel';
import {
  OFFLINE_ACTION_REASON,
  useBillingAccount,
  useInbox,
  useLocalDrafts,
  useOnline,
  useSenderContext,
  useSenderEnvelopes,
} from '../inbox/queries';
import {
  homeModel,
  NO_TASKS_TEXT,
  type AssignedTask,
  type HomeChip,
  type HomeChipFilter,
  type HomeModel,
} from './homeModel';
import { SWIPE_HINT_TEXT, useSwipeHint } from './swipeHint';

/** Prototype plan-banner navy (handoff §2A: `#011F8D`, 16 radius) on both platforms. */
const PLAN_NAVY = '#011F8D';
const SIGNATURE_ICON = 'M3 17c3-1 5-9 7-9s0 9 2 9 3-5 5-5 2 3 4 3M3 21h18';

type AgreementsTarget = HomeChipFilter | 'all';

export function HomeBody() {
  const t = useTheme();
  const navigation = useNavigation();
  const online = useOnline();
  const sent = useSenderEnvelopes();
  const inbox = useInbox();
  const billing = useBillingAccount();
  const ctx = useSenderContext();
  const local = useLocalDrafts();
  const hint = useSwipeHint();
  const [refreshing, setRefreshing] = useState(false);

  // Local drafts change outside the query cache (Send flow): re-read on focus.
  const refetchLocal = local.refetch;
  useFocusEffect(
    useCallback(() => {
      void refetchLocal();
    }, [refetchLocal]),
  );

  const rows = useMemo(
    () => mergeAgreements(sent.data?.items ?? [], inbox.data ?? null, local.data ?? []),
    [sent.data, inbox.data, local.data],
  );
  const model = useMemo(
    () =>
      homeModel({
        rows,
        displayName: ctx.data?.user.display_name,
        billing: billing.data ?? null,
      }),
    [rows, ctx.data, billing.data],
  );
  const loading = (sent.isPending || inbox.isPending) && rows.length === 0;
  const failed = (sent.isError || inbox.isError) && rows.length === 0;

  async function refresh(): Promise<void> {
    setRefreshing(true);
    await Promise.allSettled([
      sent.refetch(),
      inbox.refetch(),
      billing.refetch(),
      local.refetch(),
      ctx.refetch(),
    ]);
    setRefreshing(false);
  }

  function openAgreements(filter: AgreementsTarget): void {
    navigation.navigate('Main', { screen: 'Agreements', params: { filter } });
  }

  // The same destinations Agreements opens for a row.
  function openRow(row: AgreementRow): void {
    if (row.kind === 'sent') navigation.navigate('EnvelopeDetail', { envelopeId: row.envelopeId });
    else if (row.kind === 'received')
      navigation.navigate('ReceivedEnvelope', { inboxItemId: row.inboxItemId });
    else navigation.navigate('SendFlow', { localDraftId: row.localDraftId });
  }

  return (
    <HomeView
      model={model}
      online={online}
      loading={loading}
      failed={failed}
      showHint={hint.visible}
      onDismissHint={hint.dismiss}
      onChip={openAgreements}
      onSign={(task) => navigation.navigate('Signing', { envelopeId: task.inboxItemId })}
      onRow={openRow}
      onViewAll={() => openAgreements('all')}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={t.color.accent}
        />
      }
    />
  );
}

export interface HomeViewProps {
  readonly model: HomeModel;
  readonly online: boolean;
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly showHint: boolean;
  readonly onDismissHint: () => void;
  readonly onChip: (filter: HomeChipFilter) => void;
  readonly onSign: (task: AssignedTask) => void;
  readonly onRow: (row: AgreementRow) => void;
  readonly onViewAll: () => void;
  readonly refreshControl?: ReactElement<RefreshControlProps>;
  readonly now?: number;
}

/** Presentational Home (testable without navigation or queries). */
export function HomeView({
  model,
  online,
  loading,
  failed,
  showHint,
  onDismissHint,
  onChip,
  onSign,
  onRow,
  onViewAll,
  refreshControl,
  now,
}: HomeViewProps) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const font = t.font.family;
  const sectionTitle = {
    color: t.color.text,
    fontFamily: font,
    fontSize: 22,
    fontWeight: (ios ? '700' : '400') as '700' | '400',
  };
  return (
    <ScrollView
      testID="home-scroll"
      style={{ flex: 1, backgroundColor: t.color.screen }}
      contentContainerStyle={{ paddingBottom: 130 }}
      refreshControl={refreshControl}
    >
      {!online ? (
        <View style={styles.offline}>
          <OfflineBanner />
        </View>
      ) : null}

      {model.banner ? (
        <View
          testID="home-plan-banner"
          accessible
          accessibilityRole="summary"
          accessibilityLabel={[model.banner.title, model.banner.body].filter(Boolean).join('. ')}
          style={[styles.plan, { backgroundColor: PLAN_NAVY }]}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.planTitle, { fontFamily: font }]}>{model.banner.title}</Text>
            {model.banner.body ? (
              <Text style={[styles.planBody, { fontFamily: font }]}>{model.banner.body}</Text>
            ) : null}
          </View>
          <View style={styles.planTile}>
            <Svg
              width={26}
              height={26}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <Path d={SIGNATURE_ICON} />
            </Svg>
          </View>
        </View>
      ) : null}

      <Text
        accessibilityRole="header"
        testID="home-welcome"
        style={[
          styles.welcome,
          {
            color: t.color.text,
            fontFamily: font,
            fontSize: ios ? 34 : 28,
            fontWeight: ios ? '700' : '400',
          },
        ]}
      >
        {model.welcome}
      </Text>

      <View style={styles.chips}>
        {model.chips.map((c) => (
          <CountChip key={c.filter} chip={c} onPress={() => onChip(c.filter)} />
        ))}
      </View>

      <Text accessibilityRole="header" style={[styles.section, sectionTitle]}>
        {model.tasksHeading}
      </Text>
      <Card style={styles.block}>
        {model.tasks.length === 0 ? (
          <Text
            testID="home-no-tasks"
            style={[styles.allClear, { color: t.color.text, fontFamily: font }]}
          >
            {loading
              ? ' '
              : failed
                ? 'Couldn’t load your tasks. Pull down to try again.'
                : NO_TASKS_TEXT}
          </Text>
        ) : (
          model.tasks.map((task, i) => (
            <TaskRow
              key={task.key}
              task={task}
              online={online}
              last={i === model.tasks.length - 1}
              onSign={() => onSign(task)}
            />
          ))
        )}
      </Card>

      <Text accessibilityRole="header" style={[styles.section, sectionTitle]}>
        Agreement activity
      </Text>
      {showHint && model.activity.length > 0 ? (
        <Card style={[styles.block, styles.hint]}>
          <Text style={{ color: t.color.text, fontFamily: font, fontSize: 15, lineHeight: 21 }}>
            {SWIPE_HINT_TEXT}
          </Text>
          <Pressable
            testID="home-hint-ok"
            onPress={onDismissHint}
            accessibilityRole="button"
            accessibilityLabel="Got it, hide this tip"
            hitSlop={8}
            style={[styles.hintOk, { minHeight: t.size.minTouch }]}
          >
            <Text
              style={{
                color: t.color.accent,
                fontFamily: font,
                fontSize: 15,
                fontWeight: ios ? '600' : '500',
              }}
            >
              Got it
            </Text>
          </Pressable>
        </Card>
      ) : null}
      {model.activity.length > 0 ? (
        <Card style={styles.block}>
          {model.activity.map((row, i) => (
            <AgreementRowItem
              key={row.key}
              row={row}
              onPress={onRow}
              last={i === model.activity.length - 1}
              now={now}
            />
          ))}
        </Card>
      ) : (
        <Card style={styles.block}>
          <Text
            testID="home-no-activity"
            style={[styles.allClear, { color: t.color.textSecondary, fontFamily: font }]}
          >
            {loading ? ' ' : 'No agreements yet'}
          </Text>
        </Card>
      )}

      <Pressable
        testID="home-view-all"
        onPress={onViewAll}
        accessibilityRole="link"
        accessibilityLabel="View all agreements"
        style={[styles.viewAll, { minHeight: t.size.minTouch }]}
      >
        <Text
          style={{
            color: t.color.accent,
            fontFamily: font,
            fontSize: 15.5,
            fontWeight: ios ? '600' : '500',
          }}
        >
          View all agreements
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function CountChip({ chip, onPress }: { readonly chip: HomeChip; readonly onPress: () => void }) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  return (
    <Pressable
      testID={`home-chip-${chip.filter}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${chip.count} ${chip.label}`}
      accessibilityHint="Opens Agreements with this filter"
      hitSlop={{ top: 4, bottom: 4 }}
      style={[
        styles.chip,
        { backgroundColor: t.color.surface, minHeight: ios ? 38 : 40 },
        ios
          ? styles.chipShadow
          : { borderWidth: 1, borderColor: t.color.surfaceBorder ?? t.color.separator },
      ]}
    >
      <Text style={{ fontFamily: t.font.family, fontSize: 14.5, color: t.color.text }}>
        <Text style={{ fontWeight: '700', color: t.color.accent }}>{chip.count}</Text>
        {` ${chip.label}`}
      </Text>
    </Pressable>
  );
}

function TaskRow({
  task,
  online,
  last,
  onSign,
}: {
  readonly task: AssignedTask;
  readonly online: boolean;
  readonly last: boolean;
  readonly onSign: () => void;
}) {
  const t = useTheme();
  const font = t.font.family;
  return (
    <View
      style={[
        styles.task,
        last
          ? null
          : { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }} accessible>
        <Text
          numberOfLines={2}
          style={{
            color: t.color.text,
            fontFamily: font,
            fontSize: t.type.rowTitle.fontSize,
            fontWeight: t.type.rowTitle.fontWeight,
            lineHeight: 20,
          }}
        >
          {task.subject}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: t.color.textSecondary, fontFamily: font, fontSize: 13.5, marginTop: 3 }}
        >
          {task.subtitle}
        </Text>
      </View>
      <Pressable
        testID={`home-sign-${task.inboxItemId}`}
        onPress={online ? onSign : undefined}
        disabled={!online}
        accessibilityRole="button"
        accessibilityLabel={`Sign ${task.subject}`}
        accessibilityHint={online ? undefined : OFFLINE_ACTION_REASON}
        accessibilityState={{ disabled: !online }}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        style={[
          styles.signPill,
          { backgroundColor: t.color.accent, opacity: online ? 1 : DISABLED_OPACITY },
        ]}
      >
        <Text style={{ color: t.color.white, fontFamily: font, fontSize: 14.5, fontWeight: '600' }}>
          Sign
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  offline: { marginHorizontal: 16, marginBottom: 12 },
  plan: {
    marginTop: 2,
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  planTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  planBody: { color: 'rgba(255,255,255,0.86)', fontSize: 14, lineHeight: 20, marginTop: 4 },
  planTile: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcome: { marginTop: 4, marginHorizontal: 16, marginBottom: 12 },
  chips: {
    marginHorizontal: 16,
    marginBottom: 22,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: 19,
    paddingHorizontal: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipShadow: {
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  section: { marginHorizontal: 16, marginBottom: 10 },
  block: { marginHorizontal: 16, marginBottom: 24 },
  allClear: { paddingVertical: 22, paddingHorizontal: 16, textAlign: 'center', fontSize: 15.5 },
  task: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  signPill: {
    height: 34,
    minWidth: 64,
    borderRadius: 17,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { marginBottom: 10, paddingVertical: 14, paddingHorizontal: 16, gap: 6 },
  hintOk: { alignSelf: 'flex-end', justifyContent: 'center', paddingHorizontal: 2 },
  viewAll: { marginHorizontal: 16, alignSelf: 'flex-start', justifyContent: 'center' },
});
