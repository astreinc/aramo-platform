// Envelope detail — RECIPIENT view of a claimed inbox item (directive §6, §7 C-6;
// Permission Contract §4.6; M-A2 §1). It renders ONLY what GET /v1/sign/inbox returns
// for the item: subject, the sender organization, the user's own status and dates.
// No other recipients, no sender administration, no activity log.
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { shortDate } from '../../features/inbox/agreementsModel';
import { findInboxItem, signedCopyToken } from '../../features/inbox/inboxSigning';
import { OFFLINE_ACTION_REASON, signKeys, useInbox, useOnline } from '../../features/inbox/queries';
import type { InboxItem } from '../../features/inbox/types';
import { EmptyState } from '../../features/inbox/ui';
import { stashGuestToken } from '../../links/guestTokenVault';
import { receivedShareTarget } from '../../features/share/shareCompleted';
import { useShare } from '../../features/share/useShare';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ReceivedEnvelope'>;

const MY_STATUS: Record<string, string> = {
  PENDING: 'Waiting for your signature',
  VIEWED: 'Opened · not signed yet',
  SIGNED: 'You signed',
  DECLINED: 'You declined',
};

export interface ReceivedEnvelopeViewProps {
  readonly item: InboxItem;
  readonly online: boolean;
  readonly onSign: () => void;
  readonly onSignedCopy: () => void;
  readonly onRemove: () => void;
  readonly busy?: boolean;
  /** Share the signed PDF (COMPLETED + can_download only, M-A4 §3.7). */
  readonly onShare?: () => void;
  readonly shareBusy?: boolean;
}

/** Presentational: every value shown comes from the inbox item itself. */
export function ReceivedEnvelopeView({
  item,
  online,
  onSign,
  onSignedCopy,
  onRemove,
  busy,
  onShare,
  shareBusy,
}: ReceivedEnvelopeViewProps) {
  const t = useTheme();
  const facts: [string, string][] = [];
  if (item.from) facts.push(['From', item.from]);
  facts.push(['Your status', MY_STATUS[item.my_status] ?? item.my_status]);
  if (item.sent_at) facts.push(['Sent', shortDate(item.sent_at)]);
  if (item.signed_at) facts.push(['You signed', shortDate(item.signed_at)]);
  if (item.completed_at) facts.push(['Completed', shortDate(item.completed_at)]);
  if (item.can_sign) facts.push(['Signing link', `Valid for ${item.signing_link_valid_days} days`]);
  if (item.envelope_expires_at && !item.completed_at)
    facts.push(['Envelope expires', shortDate(item.envelope_expires_at)]);
  return (
    <View style={{ gap: 16 }} testID="received-view">
      {!online ? <OfflineBanner /> : null}
      <View style={{ gap: 6 }}>
        <StatusPill status={item.can_sign ? 'NEEDS_ME' : item.envelope_status} />
        <Text
          accessibilityRole="header"
          style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.detailTitle }}
        >
          {item.subject}
        </Text>
      </View>
      <Card>
        {facts.map(([k, v], i) => (
          <View
            key={k}
            accessible
            accessibilityLabel={`${k}: ${v}`}
            style={[
              styles.fact,
              i < facts.length - 1
                ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator }
                : null,
            ]}
          >
            <Text style={{ color: t.color.textSecondary, fontSize: 15 }}>{k}</Text>
            <Text style={{ color: t.color.text, fontSize: 15, flexShrink: 1, textAlign: 'right' }}>
              {v}
            </Text>
          </View>
        ))}
      </Card>
      {item.can_sign ? (
        <Button
          testID="received-sign"
          title="Review and sign"
          disabled={!online}
          onPress={onSign}
        />
      ) : null}
      {item.can_download ? (
        <Button
          testID="received-copy"
          title="View signed copy"
          variant="secondary"
          disabled={!online}
          busy={busy}
          onPress={onSignedCopy}
        />
      ) : null}
      {onShare && receivedShareTarget(item) ? (
        <Button
          testID="received-share"
          title="Share signed PDF"
          variant="secondary"
          disabled={!online}
          busy={shareBusy}
          onPress={onShare}
        />
      ) : null}
      {!online ? (
        <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{OFFLINE_ACTION_REASON}</Text>
      ) : null}
      <Button title="Remove from my inbox" variant="text" disabled={!online} onPress={onRemove} />
    </View>
  );
}

export function ReceivedEnvelopeScreen({ route, navigation }: Props) {
  const { inboxItemId } = route.params;
  const t = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const { workspace } = useServices();
  const online = useOnline();
  const inbox = useInbox();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sharer = useShare();
  const item = findInboxItem(inbox.data, inboxItemId);

  async function signedCopy(): Promise<void> {
    setBusy(true);
    try {
      const token = await signedCopyToken(workspace, inboxItemId);
      if (token)
        navigation.navigate('GuestSigning', { handle: stashGuestToken(token), mode: 'download' });
    } catch {
      toast.show('The signed copy isn’t ready yet.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    try {
      await workspace.call('/v1/sign/inbox/{id}', 'delete', { path: { id: inboxItemId } });
      await qc.invalidateQueries({ queryKey: signKeys.inbox });
      toast.show('Removed from your inbox');
      navigation.goBack();
    } catch {
      toast.show('Couldn’t remove it. Try again.');
    }
  }

  if (!item) {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        {inbox.isPending ? (
          <ActivityIndicator color={t.color.accent} />
        ) : (
          <EmptyState title="Not in your inbox" body="This envelope is no longer in your inbox." />
        )}
      </View>
    );
  }
  return (
    <ScrollView
      style={{ backgroundColor: t.color.screen }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void inbox.refetch().finally(() => setRefreshing(false));
          }}
          tintColor={t.color.accent}
        />
      }
    >
      <ReceivedEnvelopeView
        item={item}
        online={online}
        busy={busy}
        onSign={() => navigation.navigate('Signing', { envelopeId: inboxItemId })}
        onSignedCopy={() => void signedCopy()}
        onRemove={() => void remove()}
        onShare={() => sharer.share(receivedShareTarget(item))}
        shareBusy={sharer.busy}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  fact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
  },
});
