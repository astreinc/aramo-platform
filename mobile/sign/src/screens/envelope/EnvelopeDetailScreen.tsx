// Envelope detail — SENDER view (handoff §4.3; directive §5, §7 C-1, C-14; M-A3 §6, §7).
// Status, progress, routing (PARALLEL / SEQUENTIAL with the current signer), the 7-day
// signing link and the envelope expiry as two separate facts, Recipients / Documents /
// Activity, and the state-gated actions: Remind (Idempotency-Key, 429 retry time),
// Void (reason + If-Match; 412 refreshes), View certificate, Continue editing.
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ListRow, RowTile } from '../../components/ListRow';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { createDocumentBytesStore } from '../../features/send/documentBytes';
import { forgetLocalDrafts } from '../../features/send/localDrafts';
import { dateTime, shortDate } from '../../features/inbox/agreementsModel';
import {
  actionsFor,
  createReminder,
  headerLine,
  nextReminderAt,
  orderedRecipients,
  progressOf,
  recipientStateLine,
  remindableSigners,
  remindLabel,
  reminderRefusalCopy,
  VOID_REASON_MIN,
  deleteDraftEnvelope,
  voidEnvelope,
} from '../../features/inbox/envelopeActions';
import {
  OFFLINE_ACTION_REASON,
  putDetail,
  signKeys,
  useEnvelopeDetail,
  useEnvelopeEvents,
  useOnline,
  useSenderContext,
} from '../../features/inbox/queries';
import { OPEN_STATUSES, type DetailRecipient, type LedgerEvent } from '../../features/inbox/types';
import { EmptyState, ProgressBar, ReasonSheet, Segments } from '../../features/inbox/ui';
import type { EnvelopeDetailTab, RootStackParamList } from '../../navigation/types';
import { recipientColor, useTheme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'EnvelopeDetail'>;

const TABS: readonly { key: EnvelopeDetailTab; label: string }[] = [
  { key: 'recipients', label: 'Recipients' },
  { key: 'documents', label: 'Documents' },
  { key: 'activity', label: 'Activity' },
];

function initialsOf(name: string): string {
  const p = name.split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '?';
}

const EVENT_LABEL: Record<string, string> = {
  ENVELOPE_CREATED: 'Created',
  ENVELOPE_SENT: 'Sent',
  ENVELOPE_IN_PROGRESS: 'Signing started',
  SESSION_EXCHANGED: 'Opened',
  DISCLOSURE_ACCEPTED: 'Agreed to sign electronically',
  SIGNER_SIGNED: 'Signed',
  SIGNER_DECLINED: 'Declined',
  ENVELOPE_COMPLETED: 'Completed',
  ENVELOPE_DECLINED: 'Declined',
  ENVELOPE_VOIDED: 'Voided',
  ENVELOPE_EXPIRED: 'Expired',
  SIGNATURE_REMINDER_SENT: 'Reminder sent',
};

export function eventLabel(e: LedgerEvent): string {
  const base =
    EVENT_LABEL[e.event_type] ??
    e.event_type
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/^./, (c) => c.toUpperCase());
  const d = e.detail;
  const reason =
    d && typeof d === 'object' && typeof d['reason'] === 'string' ? (d['reason'] as string) : null;
  return reason ? `${base} · “${reason}”` : base;
}

export function eventTone(type: string): 'success' | 'destructive' | 'amber' | 'accent' {
  if (/SIGNED|COMPLETED/.test(type)) return 'success';
  if (/DECLINED|VOIDED/.test(type)) return 'destructive';
  if (/EXPIRED/.test(type)) return 'amber';
  return 'accent';
}

export function EnvelopeDetailScreen({ route, navigation }: Props) {
  const { envelopeId, initialTab } = route.params;
  const t = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const services = useServices();
  const { workspace } = services;
  const [deleteBusy, setDeleteBusy] = useState(false);
  const online = useOnline();
  const ctx = useSenderContext();
  const q = useEnvelopeDetail(envelopeId);
  const [tab, setTab] = useState<EnvelopeDetailTab>(initialTab ?? 'recipients');
  const events = useEnvelopeEvents(envelopeId, tab === 'activity');
  const [reminded, setReminded] = useState(false);
  const [remindBusy, setRemindBusy] = useState(false);
  const [remindNote, setRemindNote] = useState<string | null>(null);
  const reminder = useRef<ReturnType<typeof createReminder> | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // A later navigation here with another tab (e.g. a notification) selects it.
  const [seenTab, setSeenTab] = useState(initialTab);
  if (initialTab !== seenTab) {
    setSeenTab(initialTab);
    if (initialTab) setTab(initialTab);
  }

  // The envelope may change elsewhere (voided on web, signed): re-read on focus.
  const refetchDetail = q.refetch;
  useFocusEffect(
    useCallback(() => {
      void refetchDetail();
    }, [refetchDetail]),
  );

  const data = q.data;
  const detail = data?.detail;

  useEffect(() => {
    navigation.setOptions({ title: '' });
  }, [navigation]);

  if (!detail) {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        {q.isError ? (
          <EmptyState
            title="Couldn’t load this envelope"
            body={isApiError(q.error) ? refusalMessage(q.error) : 'Pull down to try again.'}
          />
        ) : (
          <ActivityIndicator color={t.color.accent} />
        )}
      </View>
    );
  }

  const actions = actionsFor(detail, ctx.data);
  const progress = progressOf(detail);
  const remindable = remindableSigners(detail);
  const coolingUntil = remindable.length === 0 ? nextReminderAt(detail) : null;
  const signers = orderedRecipients(detail);
  const isOpen = OPEN_STATUSES.has(detail.status);
  const offlineReason = online ? null : OFFLINE_ACTION_REASON;

  async function refresh(): Promise<void> {
    setRefreshing(true);
    await Promise.allSettled([q.refetch(), events.refetch()]);
    setRefreshing(false);
  }

  async function remind(): Promise<void> {
    // One Idempotency-Key per user intent; a retry of the same intent reuses it.
    const signerId = remindable.length === 1 ? remindable[0]?.id : undefined;
    reminder.current ??= createReminder(workspace, envelopeId, signerId);
    setRemindBusy(true);
    setRemindNote(null);
    try {
      const value = await reminder.current.send();
      putDetail(qc, value);
      reminder.current = null;
      setReminded(true);
      toast.show('Reminder sent');
      void qc.invalidateQueries({ queryKey: signKeys.events(envelopeId) });
    } catch (e) {
      if (isApiError(e) && !e.isNetwork) reminder.current = null;
      setRemindNote(
        isApiError(e)
          ? reminderRefusalCopy(e)
          : refusalMessage({ reason: 'unknown', code: 'unknown' }),
      );
    } finally {
      setRemindBusy(false);
    }
  }

  async function doVoid(reason: string): Promise<void> {
    if (!data) return;
    setVoidBusy(true);
    setVoidError(null);
    const r = await voidEnvelope(workspace, data, reason);
    setVoidBusy(false);
    if (r.kind === 'voided') {
      putDetail(qc, r.value);
      setVoidOpen(false);
      toast.show('Envelope voided');
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
      void qc.invalidateQueries({ queryKey: signKeys.events(envelopeId) });
    } else if (r.kind === 'stale') {
      // 412: never resubmit against a stale envelope — refresh and show its state now.
      setVoidOpen(false);
      toast.show(refusalMessage({ reason: 'revision_mismatch', code: 'revision_mismatch' }));
      await q.refetch();
    } else setVoidError(r.message);
  }

  // Delete draft (D-W6-3): confirm, delete with the last-read ETag, then drop the
  // on-device copy. A 412 refreshes (never resubmits) like Void.
  function confirmDelete(): void {
    Alert.alert('Delete this draft?', 'Its documents, recipients and fields are removed. This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void doDelete() },
    ]);
  }

  async function doDelete(): Promise<void> {
    if (!data) return;
    setDeleteBusy(true);
    const r = await deleteDraftEnvelope(workspace, data);
    setDeleteBusy(false);
    if (r.kind === 'deleted') {
      await forgetLocalDrafts(services.drafts, createDocumentBytesStore(services.store), {
        envelopeId,
      }).catch(() => 0);
      toast.show('Draft deleted');
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
      void qc.invalidateQueries({ queryKey: signKeys.localDrafts });
      navigation.goBack();
    } else if (r.kind === 'stale') {
      toast.show(refusalMessage({ reason: 'revision_mismatch', code: 'revision_mismatch' }));
      await q.refetch();
    } else toast.show(r.message);
  }

  const toneColor = (tone: string) =>
    tone === 'success'
      ? t.color.success
      : tone === 'destructive'
        ? t.color.destructive
        : tone === 'amber'
          ? '#B45309'
          : tone === 'accent'
            ? t.color.accent
            : t.color.textSecondary;

  function recipientRow(r: DetailRecipient, i: number) {
    const line = recipientStateLine(r, shortDate);
    const you = ctx.data?.user.email && r.email !== null && r.email.toLowerCase() === ctx.data.user.email.toLowerCase();
    const isCurrent = detail?.routing_mode === 'SEQUENTIAL' && detail.next_signer_id === r.id;
    return (
      <View
        key={r.id}
        style={[
          styles.recipient,
          {
            borderBottomColor: t.color.separator,
            borderBottomWidth: i === signers.length - 1 ? 0 : t.size.separatorWidth,
          },
        ]}
        accessible
        accessibilityLabel={`${r.name}${you ? ', you' : ''}, ${r.email}, ${line.text}${isCurrent ? ', signing now' : ''}`}
      >
        <View style={[styles.avatar, { backgroundColor: recipientColor(i) }]}>
          <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 13 }}>
            {initialsOf(r.name)}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: t.color.text, fontSize: 16, fontWeight: '500' }}>
            {detail?.routing_mode === 'SEQUENTIAL' && r.signing_order !== null
              ? `${r.signing_order}. `
              : ''}
            {r.name}
            {you ? ' (you)' : ''}
          </Text>
          <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{r.email}</Text>
          <Text style={{ color: toneColor(line.tone), fontSize: 13 }}>
            {line.text}
            {isCurrent ? ' · signing now' : ''}
          </Text>
          {r.decline_reason ? (
            <Text
              style={{ color: t.color.textSecondary, fontStyle: 'italic', fontSize: 13 }}
            >{`“${r.decline_reason}”`}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  const currentSigner =
    detail.routing_mode === 'SEQUENTIAL'
      ? detail.recipients.find((r) => r.id === detail.next_signer_id)
      : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen }}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={t.color.accent}
          />
        }
      >
        {!online ? <OfflineBanner /> : null}
        <View style={{ gap: 6 }}>
          <StatusPill status={detail.status} />
          <Text
            accessibilityRole="header"
            style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.detailTitle }}
          >
            {detail.subject}
          </Text>
          <Text style={{ color: t.color.textSecondary, fontSize: 14 }}>
            {headerLine(detail, shortDate)}
          </Text>
        </View>

        {detail.status !== 'DRAFT' ? (
          <Card style={styles.card}>
            <Text
              style={{ color: t.color.text, fontSize: 15, fontWeight: '600' }}
            >{`${progress.signed} of ${progress.total} signed`}</Text>
            <ProgressBar
              fraction={progress.total ? progress.signed / progress.total : 0}
              color={
                progress.tone === 'success'
                  ? t.color.success
                  : progress.tone === 'destructive'
                    ? t.color.destructive
                    : t.color.accent
              }
            />
            <Text style={{ color: t.color.textSecondary, fontSize: 13 }} testID="routing-line">
              {detail.routing_mode === 'SEQUENTIAL'
                ? currentSigner
                  ? `Signs in order · now signing: ${currentSigner.name}`
                  : 'Signs in order'
                : 'Everyone signs at the same time'}
            </Text>
            {isOpen ? (
              <View style={{ gap: 2 }} testID="expiry-lines">
                <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>
                  {`Signing link valid for ${detail.signing_link_valid_days ?? 7} days`}
                </Text>
                {detail.envelope_expires_at ? (
                  <Text
                    style={{ color: t.color.textSecondary, fontSize: 13 }}
                  >{`Envelope expires ${shortDate(detail.envelope_expires_at)}`}</Text>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        {detail.message ? (
          <Card style={styles.card}>
            <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>Message</Text>
            <Text style={{ color: t.color.text, fontSize: 15, lineHeight: 21 }}>
              {detail.message}
            </Text>
          </Card>
        ) : null}

        {actions.continueEditing ? (
          <Button
            testID="action-continue"
            title="Continue editing"
            onPress={() => navigation.navigate('SendFlow', { envelopeId })}
          />
        ) : null}
        {actions.deleteDraft ? (
          <Button
            testID="action-delete-draft"
            variant="destructive"
            title="Delete draft"
            busy={deleteBusy}
            disabled={!online}
            onPress={confirmDelete}
          />
        ) : null}
        {actions.viewCertificate ? (
          <Button
            testID="action-certificate"
            title="View certificate"
            disabled={!online}
            onPress={() =>
              navigation.navigate('DocumentViewer', { envelopeId, kind: 'certificate' })
            }
          />
        ) : null}

        <Segments items={TABS} value={tab} onChange={setTab} testIDPrefix="detail-tab" />

        {tab === 'recipients' ? (
          <Card>
            {signers.length ? (
              signers.map(recipientRow)
            ) : (
              <EmptyState title="No recipients yet" body="Add who needs to sign." />
            )}
          </Card>
        ) : null}

        {tab === 'documents' ? (
          <Card>
            {detail.documents.length === 0 ? (
              <EmptyState title="No documents yet" body="Add a PDF to this envelope." />
            ) : null}
            {[...detail.documents]
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((d, i, all) => (
                <ListRow
                  key={d.id}
                  title={d.title}
                  subtitle={
                    d.byte_size ? `${Math.max(1, Math.round(d.byte_size / 1024))} KB` : undefined
                  }
                  leading={<RowTile background={t.color.fill} color={t.color.textSecondary} />}
                  onPress={() =>
                    navigation.navigate('DocumentViewer', {
                      envelopeId,
                      documentId: d.id,
                      kind: detail.status === 'COMPLETED' ? 'executed' : 'source',
                    })
                  }
                  showSeparator={i < all.length - 1}
                />
              ))}
          </Card>
        ) : null}

        {tab === 'activity' ? (
          <Card style={styles.card}>
            {events.isPending ? <ActivityIndicator color={t.color.accent} /> : null}
            {(events.data ?? [])
              .slice()
              .reverse()
              .map((e) => (
                <View
                  key={e.id}
                  style={styles.event}
                  accessible
                  accessibilityLabel={`${eventLabel(e)}, ${e.actor}, ${dateTime(e.occurred_at)}`}
                >
                  <View
                    style={[
                      styles.eventDot,
                      { backgroundColor: toneColor(eventTone(e.event_type)) },
                    ]}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.color.text, fontSize: 15 }}>{eventLabel(e)}</Text>
                    <Text
                      style={{ color: t.color.textSecondary, fontSize: 13 }}
                    >{`${e.actor} · ${dateTime(e.occurred_at)}`}</Text>
                  </View>
                </View>
              ))}
            {events.data && events.data.length === 0 ? (
              <Text style={{ color: t.color.textSecondary }}>No activity yet.</Text>
            ) : null}
          </Card>
        ) : null}

        {actions.remind || actions.void ? (
          <View style={{ gap: 10 }} testID="sender-actions">
            {actions.remind ? (
              <Button
                testID="action-remind"
                variant="secondary"
                title={
                  reminded
                    ? 'Reminder sent'
                    : remindable.length
                      ? remindLabel(remindable)
                      : 'Send reminder'
                }
                disabled={!online || reminded || remindable.length === 0}
                busy={remindBusy}
                accessibilityHint={offlineReason ?? undefined}
                onPress={() => void remind()}
              />
            ) : null}
            {actions.remind && coolingUntil && !reminded ? (
              <Text
                style={{ color: t.color.textSecondary, fontSize: 13 }}
              >{`You can send another reminder at ${dateTime(coolingUntil)}.`}</Text>
            ) : null}
            {remindNote ? (
              <Text
                accessibilityRole="alert"
                style={{ color: t.color.textSecondary, fontSize: 13 }}
                testID="remind-note"
              >
                {remindNote}
              </Text>
            ) : null}
            {actions.void ? (
              <Button
                testID="action-void"
                variant="destructive"
                title="Void envelope"
                disabled={!online}
                onPress={() => setVoidOpen(true)}
              />
            ) : null}
            {offlineReason ? (
              <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{offlineReason}</Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <ReasonSheet
        visible={voidOpen}
        title="Void this envelope?"
        body="Recipients can no longer open or sign it. They’re told it was voided. This can’t be undone."
        confirmLabel="Void envelope"
        placeholder="Reason (required)"
        minLength={VOID_REASON_MIN}
        busy={voidBusy}
        error={voidError}
        disabledReason={offlineReason}
        onConfirm={(r) => void doVoid(r)}
        onClose={() => setVoidOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  card: { padding: 14, gap: 8 },
  recipient: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  event: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 6 },
  eventDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
});
