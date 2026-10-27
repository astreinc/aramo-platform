// Agreements tab (handoff §4.2, §4.10; directive §5, §7 C-3, C-12). One list for what the
// user sent (GET /v1/sign/sender/envelopes) and what they received and claimed
// (GET /v1/sign/inbox), plus local drafts, filtered Needs me / Waiting / Drafts / Done.
// Cached data shows offline ("Offline · showing saved data").
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { Banner, OfflineBanner } from '../../components/Banner';
import { Card } from '../../components/Card';
import {
  countFor,
  EMPTY_STATE,
  filterAgreements,
  FILTER_LABEL,
  FILTERS,
  mergeAgreements,
  needsSignatureSummary,
  shortDate,
  type AgreementRow,
} from '../../features/inbox/agreementsModel';
import { useServices } from '../../app/ServicesContext';
import { useToast } from '../../components/Toast';
import { refusalMessage } from '../../api/refusalMessages';
import { AgreementRowItem } from '../../features/inbox/AgreementRowItem';
import { deleteDraftById } from '../../features/inbox/envelopeActions';
import { SwipeToDelete } from '../../features/inbox/SwipeToDelete';
import { createDocumentBytesStore } from '../../features/send/documentBytes';
import { forgetLocalDrafts } from '../../features/send/localDrafts';
import { allowanceChipText, allowanceModel, limitBanner } from '../../features/inbox/allowance';
import {
  signKeys,
  useBillingAccount,
  useInbox,
  useLocalDrafts,
  useOnline,
  useSenderContext,
  useSenderEnvelopes,
} from '../../features/inbox/queries';
import { EmptyState, Segments } from '../../features/inbox/ui';
import type { AgreementsFilter, MainTabParamList } from '../../navigation/types';
import { useTheme } from '../../theme';

function initials(name: string | null | undefined): string {
  const parts = (name ?? '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·';
}

function Avatar({
  name,
  onPress,
}: {
  readonly name: string | null | undefined;
  readonly onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Account"
      hitSlop={6}
      style={[styles.avatar, { backgroundColor: t.color.tint }]}
    >
      <Text style={{ color: t.color.onTint, fontWeight: '600', fontSize: 14 }}>
        {initials(name)}
      </Text>
    </Pressable>
  );
}

export function AgreementsScreen() {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<MainTabParamList, 'Agreements'>>();
  const online = useOnline();
  const sent = useSenderEnvelopes();
  const inbox = useInbox();
  const billing = useBillingAccount();
  const ctx = useSenderContext();
  const local = useLocalDrafts();
  const [filter, setFilter] = useState<AgreementsFilter>(route.params?.filter ?? 'needs_me');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // A navigation to Agreements with a filter (e.g. "Saved to Drafts") selects it.
  const [seenFilter, setSeenFilter] = useState(route.params?.filter);
  if (route.params?.filter !== seenFilter) {
    setSeenFilter(route.params?.filter);
    if (route.params?.filter) setFilter(route.params.filter);
  }

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
  const visible = useMemo(() => filterAgreements(rows, filter, query), [rows, filter, query]);
  const needs = needsSignatureSummary(rows);
  const allowance = allowanceModel(billing.data ?? null);
  const banner = limitBanner(allowance);
  const canSend = ctx.data?.can_send === true;
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

  function open(row: AgreementRow): void {
    if (row.kind === 'sent') navigation.navigate('EnvelopeDetail', { envelopeId: row.envelopeId });
    else if (row.kind === 'received')
      navigation.navigate('ReceivedEnvelope', { inboxItemId: row.inboxItemId });
    else navigation.navigate('SendFlow', { localDraftId: row.localDraftId });
  }

  // Swipe left to delete a draft (D-W6-3). A server draft is deleted with its current
  // ETag; an on-device draft is only forgotten locally. Either way the on-device copy
  // and its document bytes go too.
  const services = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const deletable = (row: AgreementRow) =>
    row.kind === 'local-draft' || (row.kind === 'sent' && row.status === 'DRAFT');
  async function deleteRow(row: AgreementRow): Promise<void> {
    const bytes = createDocumentBytesStore(services.store);
    if (row.kind === 'local-draft') {
      await forgetLocalDrafts(services.drafts, bytes, { localDraftId: row.localDraftId });
    } else if (row.kind === 'sent') {
      const r = await deleteDraftById(services.workspace, row.envelopeId);
      if (r.kind !== 'deleted') {
        toast.show(
          r.kind === 'stale'
            ? refusalMessage({ reason: 'revision_mismatch', code: 'revision_mismatch' })
            : r.message,
        );
        return;
      }
      await forgetLocalDrafts(services.drafts, bytes, { envelopeId: row.envelopeId }).catch(() => 0);
    } else return;
    toast.show('Draft deleted');
    void qc.invalidateQueries({ queryKey: signKeys.senderList });
    void local.refetch();
  }

  const newEnvelope = () => navigation.navigate('SendFlow', undefined);
  const openAccount = () => navigation.navigate('Main', { screen: 'Account' });

  const segments = FILTERS.map((k) => ({
    key: k,
    label: k === 'needs_me' ? `${FILTER_LABEL[k]} ${countFor(rows, k)}` : FILTER_LABEL[k],
  }));

  const dotColor =
    allowance?.dot === 'month_reached'
      ? t.color.destructive
      : allowance?.dot === 'day_reached'
        ? '#B45309'
        : t.color.success;

  const header = (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      {ios ? (
        <>
          <View style={styles.iosTopRow}>
            {canSend ? (
              <Pressable
                testID="agreements-new"
                onPress={newEnvelope}
                accessibilityRole="button"
                accessibilityLabel="New envelope"
                hitSlop={6}
                style={[styles.plus, { backgroundColor: t.color.white }]}
              >
                <Svg
                  width={20}
                  height={20}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={t.color.accent}
                  strokeWidth={2.2}
                  strokeLinecap="round"
                >
                  <Path d="M12 5v14M5 12h14" />
                </Svg>
              </Pressable>
            ) : null}
            <Avatar name={ctx.data?.user.display_name} onPress={openAccount} />
          </View>
          <Text
            accessibilityRole="header"
            style={[styles.pad, { color: t.color.text, ...t.type.largeTitle }]}
          >
            Agreements
          </Text>
        </>
      ) : (
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
            Agreements
          </Text>
          <Avatar name={ctx.data?.user.display_name} onPress={openAccount} />
        </View>
      )}
      {allowance ? (
        <View
          style={[styles.pad, styles.chip]}
          accessible
          accessibilityLabel={allowanceChipText(allowance)}
          testID="allowance-chip"
        >
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
            {allowanceChipText(allowance)}
          </Text>
        </View>
      ) : null}
      {!online ? (
        <View style={styles.pad}>
          <OfflineBanner />
        </View>
      ) : null}
      {banner ? (
        <View style={styles.pad} testID="limit-banner">
          <Banner title={banner.title} body={banner.body} />
        </View>
      ) : null}
      <View style={styles.pad}>
        <TextInput
          testID="agreements-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Search agreements"
          placeholderTextColor={t.color.textSecondary}
          accessibilityLabel="Search agreements"
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={
            ios
              ? [styles.searchIos, { backgroundColor: t.color.fill, color: t.color.text }]
              : [
                  styles.searchAndroid,
                  { backgroundColor: '#EEEDF4', color: t.color.text, fontFamily: t.font.family },
                ]
          }
        />
      </View>
      {needs.count > 0 && filter !== 'needs_me' && needs.newest ? (
        <View style={styles.pad}>
          <View
            testID="needs-card"
            style={[styles.needsCard, { backgroundColor: ios ? t.color.accent : t.color.tint }]}
          >
            <Text
              style={{
                color: ios ? t.color.white : t.color.onTint,
                fontSize: 15,
                fontWeight: '600',
              }}
            >
              {needs.count === 1
                ? '1 agreement needs your signature'
                : `${needs.count} agreements need your signature`}
            </Text>
            <Text
              numberOfLines={2}
              style={{
                color: ios ? t.color.white : t.color.onTint,
                fontSize: 17,
                fontWeight: '600',
              }}
            >
              {needs.newest.subject}
            </Text>
            <Text style={{ color: ios ? 'rgba(255,255,255,0.8)' : t.color.onTint, fontSize: 13 }}>
              {`From ${needs.newest.item.from ?? 'the sender'} · sent ${shortDate(needs.newest.item.sent_at)}`}
            </Text>
            <Pressable
              testID="needs-card-sign"
              onPress={() =>
                navigation.navigate('Signing', { envelopeId: needs.newest?.inboxItemId ?? '' })
              }
              disabled={!online}
              accessibilityRole="button"
              accessibilityLabel="Review and sign"
              accessibilityHint={online ? undefined : 'You’re offline'}
              accessibilityState={{ disabled: !online }}
              style={[
                styles.needsButton,
                {
                  backgroundColor: ios ? t.color.white : t.color.accent,
                  borderRadius: t.button.primary.radius,
                  minHeight: t.size.minTouch,
                  opacity: online ? 1 : 0.42,
                },
              ]}
            >
              <Text
                style={{
                  color: ios ? t.color.accent : t.color.white,
                  fontWeight: '600',
                  fontSize: 16,
                }}
              >
                Review and sign
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <Segments items={segments} value={filter} onChange={setFilter} testIDPrefix="filter" />
    </View>
  );

  const empty = loading ? null : failed ? (
    <EmptyState title="Couldn’t load agreements" body="Pull down to try again." />
  ) : query.trim() ? (
    <EmptyState {...EMPTY_STATE.search} />
  ) : (
    <EmptyState {...EMPTY_STATE[filter]} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen, paddingTop: insets.top }}>
      <FlatList
        data={visible}
        keyExtractor={(r) => r.key}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        renderItem={({ item, index }) => (
          <Card
            style={[
              styles.rowCard,
              index === 0 ? styles.first : null,
              index === visible.length - 1 ? styles.last : null,
            ]}
          >
            <SwipeToDelete
              enabled={deletable(item) && (item.kind === 'local-draft' || online)}
              label={item.subject}
              onDelete={() => void deleteRow(item)}
            >
              <AgreementRowItem row={item} onPress={open} last={index === visible.length - 1} />
            </SwipeToDelete>
          </Card>
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={t.color.accent}
          />
        }
        contentContainerStyle={{ paddingBottom: ios ? 24 : 120 }}
        keyboardShouldPersistTaps="handled"
      />
      {!ios && canSend ? (
        <Pressable
          testID="agreements-fab"
          onPress={newEnvelope}
          accessibilityRole="button"
          accessibilityLabel="New envelope"
          style={[styles.fab, { backgroundColor: t.color.tint, bottom: 16 }]}
        >
          <Text style={{ color: t.color.onTint, fontSize: 15, fontWeight: '500' }}>+ New</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { marginHorizontal: 16 },
  iosTopRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  plus: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  androidBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 64 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  searchIos: { height: 36, borderRadius: 10, paddingHorizontal: 12, fontSize: 17 },
  searchAndroid: { height: 56, borderRadius: 28, paddingHorizontal: 20, fontSize: 16 },
  needsCard: { borderRadius: 16, padding: 16, gap: 6 },
  needsButton: {
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  rowCard: { marginHorizontal: 16, borderRadius: 0 },
  first: { borderTopLeftRadius: 12, borderTopRightRadius: 12, marginTop: 8 },
  last: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  fab: {
    position: 'absolute',
    right: 16,
    height: 56,
    borderRadius: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
});
