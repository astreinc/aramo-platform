// M-A17 §1–§2 (UAT SIG-15 retest, web ≡ app) — the recipient's own Deleted folder with
// Restore, reached from the foot of Agreements (the web: Waiting for me → "Show deleted").
// Only received envelopes this user deleted; the sender and other recipients see no change.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useToast } from '../../components/Toast';
import { DELETED_COPY, fetchDeletedInbox, restoreInboxItem } from '../../features/inbox/deletedInbox';
import { signKeys, useOnline } from '../../features/inbox/queries';
import type { InboxItem } from '../../features/inbox/types';
import { EmptyState } from '../../features/inbox/ui';
import { useTheme } from '../../theme';

export const deletedInboxKey = [...signKeys.inbox, 'deleted'] as const;

export function DeletedInboxScreen() {
  const { workspace } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const deleted = useQuery({ queryKey: deletedInboxKey, queryFn: () => fetchDeletedInbox(workspace) });
  const [busyId, setBusyId] = useState<string | null>(null);

  async function restore(item: InboxItem): Promise<void> {
    setBusyId(item.id);
    const outcome = await restoreInboxItem(workspace, item.id);
    setBusyId(null);
    toast.show(DELETED_COPY[outcome]);
    // Restored (or already gone): refresh both the inbox and this list.
    if (outcome !== 'failed') await qc.invalidateQueries({ queryKey: signKeys.inbox });
  }

  return (
    <DeletedInboxView
      items={deleted.data ?? null}
      loading={deleted.isPending}
      failed={deleted.isError}
      online={online}
      busyId={busyId}
      refreshing={deleted.isRefetching}
      onRefresh={() => void deleted.refetch()}
      onRestore={(i) => void restore(i)}
    />
  );
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
}: {
  readonly items: readonly InboxItem[] | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly online: boolean;
  readonly busyId: string | null;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRestore: (item: InboxItem) => void;
}) {
  const t = useTheme();
  // UAT AND (bottom spacing) — keep the last actions above Android's navigation bar.
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.color.screen }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 16 + insets.bottom }}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {!online ? <OfflineBanner /> : null}
      <Text style={{ color: t.color.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: t.font.family }}>
        Envelopes you deleted from your inbox. Restore brings one back. The sender’s envelope isn’t affected.
      </Text>
      {loading ? (
        <ActivityIndicator color={t.color.accent} />
      ) : failed ? (
        <EmptyState title="Couldn’t load" body={DELETED_COPY.loadFailed} />
      ) : !items || items.length === 0 ? (
        <EmptyState title="Deleted" body={DELETED_COPY.empty} />
      ) : (
        <Card>
          {items.map((i, n) => (
            <View
              key={i.id}
              testID={`deleted-row-${i.id}`}
              style={[
                styles.row,
                n < items.length - 1
                  ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.separator }
                  : null,
              ]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }} numberOfLines={2}>
                  {i.subject}
                </Text>
                <Text style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>
                  {i.from ?? 'An Aramo Sign sender'}
                </Text>
              </View>
              <Button
                testID={`deleted-restore-${i.id}`}
                title="Restore"
                variant="secondary"
                busy={busyId === i.id}
                disabled={!online || (busyId !== null && busyId !== i.id)}
                accessibilityHint={`Moves ${i.subject} back to your inbox`}
                onPress={() => onRestore(i)}
              />
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
});
