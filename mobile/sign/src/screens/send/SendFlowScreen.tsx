// Send flow (handoff §4.6, adapted by directive §5, §7 and §9): full screen, Cancel /
// "New envelope" or "Edit draft" / Next, the four-step stepper, then Documents ->
// Recipients -> Fields -> Review. Entry: "+ New" (no params), a local draft
// (localDraftId) or "Continue editing" (envelopeId), opening at the furthest step with
// data. Preparation is saved on the device as it happens (encrypted) and reaches the
// server only on Save as draft, Review and Send, always with If-Match.
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Banner, OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { allowanceModel, limitBanner } from '../../features/inbox/allowance';
import { signKeys, useBillingAccount, useOnline, useSenderContext } from '../../features/inbox/queries';
import { hasContent } from '../../features/send/draftModel';
import { SAVED_ON_DEVICE, SAVED_TO_DRAFTS, sentToast } from '../../features/send/sendCopy';
import { templatesAvailable } from '../../features/send/templates';
import { useSendFlow } from '../../features/send/useSendFlow';
import type { RootStackParamList } from '../../navigation/types';
import type { SendStep } from '../../state/draftStore';
import { useTheme } from '../../theme';
import { CancelSheet } from './CancelSheet';
import { DocumentsStep } from './DocumentsStep';
import { FieldsStep } from './FieldsStep';
import { RecipientsStep } from './RecipientsStep';
import { ReviewStep } from './ReviewStep';
import { Stepper } from './Stepper';

type Props = NativeStackScreenProps<RootStackParamList, 'SendFlow'>;

const NEXT: Partial<Record<SendStep, SendStep>> = {
  documents: 'recipients',
  recipients: 'fields',
  fields: 'review',
};

export function SendFlowScreen({ navigation, route }: Props) {
  const t = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const params = route.params ?? {};
  const { controller, state } = useSendFlow(params);
  const context = useSenderContext();
  const billing = useBillingAccount();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const leaving = useRef(false);

  const p = state.draft?.payload;
  const editing = Boolean(params.envelopeId || state.draft?.envelopeId);
  const limit = limitBanner(allowanceModel(billing.data));
  const user = context.data?.user;
  const me = user?.email ? { name: user.display_name || user.email, email: user.email } : null;

  const refreshLists = useCallback(() => {
    void qc.invalidateQueries({ queryKey: signKeys.senderList });
    void qc.invalidateQueries({ queryKey: signKeys.localDrafts });
  }, [qc]);

  const leave = useCallback(
    (go: () => void) => {
      leaving.current = true;
      refreshLists();
      go();
    },
    [refreshLists],
  );

  const goTo = useCallback(
    (step: SendStep) => {
      controller.setStep(step);
      // Review reads the server's view (readiness, expiry) and pushes local changes.
      if (step === 'review' && online) void controller.sync();
    },
    [controller, online],
  );

  const nextStep = NEXT[state.step];
  const nextEnabled =
    !!p &&
    state.busy === null &&
    (state.step === 'documents'
      ? p.documents.length > 0
      : state.step === 'recipients'
        ? p.recipients.length > 0
        : state.step === 'fields');

  // Leaving with nothing added: no question, and no empty local draft left behind.
  const dropIfEmpty = useCallback(() => {
    if ((!p || !hasContent(p)) && !controller.hasServerEnvelope) void controller.discard();
  }, [p, controller]);

  const onCancel = useCallback(() => {
    if (!p || !hasContent(p)) {
      dropIfEmpty();
      leave(() => navigation.goBack());
    } else setCancelOpen(true);
  }, [p, leave, navigation, dropIfEmpty]);

  const saveDraft = useCallback(async () => {
    setSaving(true);
    const where = await controller.saveDraft();
    setSaving(false);
    setCancelOpen(false);
    if (controller.snapshot.notice) return; // changed elsewhere: stay and show it
    toast.show(where === 'synced' ? SAVED_TO_DRAFTS : SAVED_ON_DEVICE);
    leave(() => navigation.navigate('Main', { screen: 'Agreements', params: { filter: 'drafts' } }));
  }, [controller, toast, leave, navigation]);

  const discard = useCallback(async () => {
    setCancelOpen(false);
    await controller.discard();
    leave(() => navigation.goBack());
  }, [controller, leave, navigation]);

  const send = useCallback(async () => {
    const out = await controller.send();
    if (!out) return;
    void qc.invalidateQueries({ queryKey: signKeys.detail(out.envelopeId) });
    toast.show(sentToast(out.signers));
    leave(() => navigation.replace('EnvelopeDetail', { envelopeId: out.envelopeId }));
  }, [controller, toast, leave, navigation, qc]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: editing ? 'Edit draft' : 'New envelope',
      headerLeft: () => <Button title="Cancel" variant="text" onPress={onCancel} />,
      headerRight: () =>
        nextStep ? (
          <Button
            title="Next"
            variant="text"
            disabled={!nextEnabled}
            onPress={() => goTo(nextStep)}
            testID="send-next"
          />
        ) : null,
    });
  }, [navigation, editing, onCancel, nextStep, nextEnabled, goTo]);

  // Android back / swipe: the same question as Cancel.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (leaving.current) return;
        if (!p || !hasContent(p)) {
          dropIfEmpty();
          return;
        }
        e.preventDefault();
        setCancelOpen(true);
      }),
    [navigation, p, dropIfEmpty],
  );

  if (state.status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading" />
      </View>
    );
  }
  if (state.status === 'failed' || !p) {
    return (
      <View style={[styles.center, { padding: 24, gap: 16 }]}>
        <Text style={{ color: t.color.text, fontSize: 16, textAlign: 'center' }}>
          {state.error ?? 'This envelope couldn’t be opened.'}
        </Text>
        <Button title="Close" variant="secondary" onPress={() => leave(() => navigation.goBack())} />
      </View>
    );
  }

  const body =
    state.step === 'documents' ? (
      <DocumentsStep
        controller={controller}
        state={state}
        limit={limit}
        templatesEnabled={templatesAvailable(context.data)}
        onPicked={(step) => goTo(step ?? 'recipients')}
      />
    ) : state.step === 'recipients' ? (
      <RecipientsStep controller={controller} state={state} me={me} online={online} />
    ) : state.step === 'review' ? (
      <ReviewStep
        controller={controller}
        state={state}
        limit={limit}
        online={online}
        onSend={() => void send()}
        onSaveDraft={() => void saveDraft()}
      />
    ) : null;

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stepper step={state.step} onStep={goTo} />
      <View style={styles.banners}>
        {!online ? <OfflineBanner /> : null}
        {state.notice ? (
          <View>
            <Banner tone="offline" body={state.notice} />
            <Button title="OK" variant="text" onPress={() => controller.dismissNotice()} />
          </View>
        ) : null}
      </View>
      {state.step === 'fields' ? (
        <FieldsStep controller={controller} state={state} />
      ) : (
        <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      )}
      <CancelSheet
        visible={cancelOpen}
        busy={saving}
        serverDraftStays={controller.hasServerEnvelope}
        onSave={() => void saveDraft()}
        onDiscard={() => void discard()}
        onKeepEditing={() => setCancelOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banners: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
});
