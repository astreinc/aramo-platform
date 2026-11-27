// The Deleted folder, reached from the foot of Agreements. Two groups:
//   - Sent by me (APP-DELETED-1, LOCKED 2026-11-27; UAT DEL-09): envelopes the user sent and moved
//     to Deleted (GET /v1/sign/sender/envelopes?folder=deleted), with Restore when the server's
//     `actions.restore` allows — as Sign web's Envelopes → Deleted. Hidden only for the user's
//     organization; recipients keep their copies.
//   - Received (M-A17 §1–§2, UAT SIG-15 retest, web ≡ app): envelopes the user removed from their
//     inbox, with Restore (web: Waiting for me → "Show deleted"). The sender is unaffected.
// Each group loads, fails and refreshes on its own. A user who may not read sent envelopes (403)
// sees the Received group only, as before.
import { ENVELOPE_DELETE_COPY, senderActionsOf } from '@aramo/sign-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useToast } from '../../components/Toast';
import { DELETED_COPY, fetchDeletedInbox, restoreInboxItem } from '../../features/inbox/deletedInbox';
import { signKeys, useOnline } from '../../features/inbox/queries';
import { fetchDeletedSent, restoreSentEnvelope } from '../../features/inbox/sentDeleted';
import type { InboxItem, SenderListItem } from '../../features/inbox/types';
import { EmptyState } from '../../features/inbox/ui';
import { useTheme } from '../../theme';

export const deletedInboxKey = [...signKeys.inbox, 'deleted'] as const;

const SENT_STATUS: Record<string, string> = {
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  VOIDED: 'Voided',
  EXPIRED: 'Expired',
};

export function DeletedInboxScreen() {
  const { workspace } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const deleted = useQuery({ queryKey: deletedInboxKey, queryFn: () => fetchDeletedInbox(workspace) });
  const sent = useQuery({ queryKey: signKeys.deletedSent, queryFn: () => fetchDeletedSent(workspace) });
  const [busyId, setBusyId] = useState<string | null>(null);

  async function restore(item: InboxItem): Promise<void> {
    setBusyId(item.id);
    const outcome = await restoreInboxItem(workspace, item.id);
    setBusyId(null);
    toast.show(DELETED_COPY[outcome]);
    // Restored (or already gone): refresh both the inbox and this list.
    if (outcome !== 'failed') await qc.invalidateQueries({ queryKey: signKeys.inbox });
  }

  async function restoreSent(item: SenderListItem): Promise<void> {
    setBusyId(item.id);
    const r = await restoreSentEnvelope(workspace, item.id);
    setBusyId(null);
    toast.show(r.message);
    // Restored or refused: the sender lists (this group included) show the server's current answer.
    await qc.invalidateQueries({ queryKey: signKeys.senderList });
  }

  return (
    <DeletedInboxView
      items={deleted.data ?? null}
      loading={deleted.isPending}
      failed={deleted.isError}
      online={online}
      busyId={busyId}
      refreshing={deleted.isRefetching || sent.isRefetching}
      onRefresh={() => {
        void deleted.refetch();
        void sent.refetch();
      }}
      onRestore={(i) => void restore(i)}
      sent={{
        items: sent.data === undefined ? undefined : sent.data,
        loading: sent.isPending,
        failed: sent.isError,
        onRestore: (i) => void restoreSent(i),
      }}
    />
  );
}

export interface DeletedSentGroup {
  /** undefined while loading; null when the user may not read sent envelopes (group hidden). */
  readonly items: readonly SenderListItem[] | null | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onRestore: (item: SenderListItem) => void;
}

export function DeletedInboxView({
  items,
  loading,
  failed,
  online,
  busyId,
  refreshing = false,
  onRefresh,
  onRestore,
  sent,
}: {
  readonly items: readonly InboxItem[] | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly online: boolean;
  readonly busyId: string | null;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRestore: (item: InboxItem) => void;
  readonly sent?: DeletedSentGroup;
}) {
  const t = useTheme();
  // UAT AND (bottom spacing) — keep the last actions above Android's navigation bar.
  const insets = useSafeAreaInsets();
  const showSent = sent !== undefined && sent.items !== null;
  const body = { color: t.color.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: t.font.family } as const;
  const heading = { color: t.color.text, fontSize: 17, fontWeight: '700', fontFamily: t.font.family } as const;
  const busyElsewhere = (id: string) => busyId !== null && busyId !== id;

  const row = (key: string, n: number, count: number, title: string, line: string, restore: ReactNode) => (
    <View
      key={key}
      testID={`deleted-row-${key}`}
      style={[
        styles.row,
        n < count - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.separator } : null,
      ]}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }} numberOfLines={2}>
          {title}
        </Text>
        <Text style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>{line}</Text>
      </View>
      {restore}
    </View>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.color.screen }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 16 + insets.bottom }}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {!online ? <OfflineBanner /> : null}

      {showSent && sent ? (
        <View testID="deleted-sent" style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={heading}>
            Sent by me
          </Text>
          <Text style={body}>{ENVELOPE_DELETE_COPY.deleted_help}</Text>
          {sent.loading ? (
            <ActivityIndicator color={t.color.accent} />
          ) : sent.failed ? (
            <Text style={body}>Couldn’t load your deleted envelopes. Pull down to try again.</Text>
          ) : !sent.items || sent.items.length === 0 ? (
            <Text style={body} testID="deleted-sent-empty">
              {ENVELOPE_DELETE_COPY.deleted_empty}
            </Text>
          ) : (
            <Card>
              {sent.items.map((e, n, all) =>
                row(
                  e.id,
                  n,
                  all.length,
                  e.subject,
                  SENT_STATUS[e.status] ?? 'Deleted',
                  senderActionsOf(e).restore ? (
                    <Button
                      testID={`deleted-sent-restore-${e.id}`}
                      title={ENVELOPE_DELETE_COPY.restore_confirm}
                      variant="secondary"
                      busy={busyId === e.id}
                      disabled={!online || busyElsewhere(e.id)}
                      accessibilityHint={`Moves ${e.subject} back to your envelopes`}
                      onPress={() => sent.onRestore(e)}
                    />
                  ) : null,
                ),
              )}
            </Card>
          )}
          <Text accessibilityRole="header" style={[heading, { marginTop: 12 }]}>
            Received
          </Text>
        </View>
      ) : null}

      <Text style={body}>Envelopes you deleted from your inbox. Restore brings one back. The sender’s envelope isn’t affected.</Text>
      {loading ? (
        <ActivityIndicator color={t.color.accent} />
      ) : failed ? (
        <EmptyState title="Couldn’t load" body={DELETED_COPY.loadFailed} />
      ) : !items || items.length === 0 ? (
        showSent ? (
          <Text style={body}>{DELETED_COPY.empty}</Text>
        ) : (
          <EmptyState title="Deleted" body={DELETED_COPY.empty} />
        )
      ) : (
        <Card>
          {items.map((i, n) =>
            row(
              i.id,
              n,
              items.length,
              i.subject,
              i.from ?? 'An Aramo Sign sender',
              <Button
                testID={`deleted-restore-${i.id}`}
                title="Restore"
                variant="secondary"
                busy={busyId === i.id}
                disabled={!online || busyElsewhere(i.id)}
                accessibilityHint={`Moves ${i.subject} back to your inbox`}
                onPress={() => onRestore(i)}
              />,
            ),
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
});
