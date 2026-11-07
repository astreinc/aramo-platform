// Send flow (handoff §4.6, adapted by directive §5, §7 and §9): full screen, Cancel /
// "New envelope" or "Edit draft" / Next, the four-step stepper, then Documents ->
// Recipients -> Fields -> Review. Entry: "+ New" (no params), a local draft
// (localDraftId) or "Continue editing" (envelopeId), opening at the furthest step with
// data. Preparation is saved on the device as it happens (encrypted) and reaches the
// server only on Save as draft, Review and Send, always with If-Match.
// "Sign a document" (intent 'self', FEATURES.selfSign; M-A4 §6.3, M-A5 §4): the user is
// pre-added as a signer with Assign to me; after Send, the app asks for a SELF session
// and opens the signing flow on the guest transport with only a vault handle.
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Banner, OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { allowanceModel, limitBanner } from '../../features/inbox/allowance';
import { signKeys, useBillingAccount, useOnline, useSenderContext } from '../../features/inbox/queries';
import { hasContent } from '../../features/send/draftModel';
import { SAVED_ON_DEVICE, SAVED_TO_DRAFTS, sentToast } from '../../features/send/sendCopy';
import { templatesAvailable } from '../../features/send/templates';
import { messagingOffered, sendFeaturesOf } from '../../features/send/sendFeatures';
import { startSelfSign } from '../../features/send/selfSign';
import { createSenderApi } from '../../features/send/senderApi';
import { stepBlocker, stepTarget } from '../../features/send/sendFlowController';
import { useSendFlow } from '../../features/send/useSendFlow';
import { FEATURES } from '../../config/features';
import { useServices } from '../../app/ServicesContext';
import type { RootStackParamList } from '../../navigation/types';
import type { SendStep } from '../../state/draftStore';
import { useTheme } from '../../theme';
import { CancelSheet } from './CancelSheet';
import { DocumentsStep } from './DocumentsStep';
import { FieldsStep } from './FieldsStep';
import { assignToMe, RecipientsStep } from './RecipientsStep';
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
  const services = useServices();
  const selfIntent = FEATURES.selfSign && params.intent === 'self';
  const context = useSenderContext();
  // B2 — the per-recipient options the server reports available.
  const features = useMemo(() => sendFeaturesOf(context.data), [context.data]);
  const { controller, state } = useSendFlow(
    {
      ...params,
      intent: selfIntent ? 'self' : 'request',
    },
    { messaging: messagingOffered(features) },
  );
  const billing = useBillingAccount();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const leaving = useRef(false);

  const p = state.draft?.payload;
  const editing = Boolean(params.envelopeId || state.draft?.envelopeId);
  const limit = limitBanner(allowanceModel(billing.data));
  const user = context.data?.user;
  const meName = user?.display_name || user?.email || '';
  const meEmail = user?.email ?? '';
  const me = useMemo(
    () => (meEmail ? { name: meName, email: meEmail } : null),
    [meName, meEmail],
  );
  const selfSign = FEATURES.selfSign && p?.selfSign === true;
  const inPerson = FEATURES.hostedSigning && context.data?.features?.in_person_signing === true;

  // "Sign a document": pre-add the user (once, while the new draft has no recipients).
  const preAdded = useRef(false);
  useEffect(() => {
    if (preAdded.current || !selfSign || !me || !p || p.recipients.length > 0) return;
    preAdded.current = true;
    assignToMe(controller, me);
  }, [selfSign, me, p, controller]);

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
  const nextEnabled = !!p && state.busy === null && stepBlocker(state.step, p) === null;

  // M-A13 #12 (R-6) — a step label goes forward only as far as Next would.
  const onStepLabel = useCallback(
    (to: SendStep) => {
      if (!p) return;
      const r = stepTarget(state.step, to, p, state.busy !== null);
      if (r.step !== state.step) goTo(r.step);
      if (r.message) toast.show(r.message);
    },
    [p, state.step, state.busy, goTo, toast],
  );

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
    if (selfSign && out.assignedSignerId) {
      const r = await startSelfSign(
        createSenderApi(services.workspace),
        out.envelopeId,
        out.assignedSignerId,
      );
      if (r.kind === 'session') {
        leave(() =>
          navigation.replace('GuestSigning', {
            handle: r.handle,
            mode: 'sign',
            origin: 'self',
            envelopeId: out.envelopeId,
          }),
        );
        return;
      }
      toast.show(r.message);
    }
    leave(() => navigation.replace('EnvelopeDetail', { envelopeId: out.envelopeId }));
  }, [controller, toast, leave, navigation, qc, selfSign, services.workspace]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: editing ? 'Edit draft' : selfSign ? 'Sign a document' : 'New envelope',
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
  }, [navigation, editing, selfSign, onCancel, nextStep, nextEnabled, goTo]);

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
      <RecipientsStep
        controller={controller}
        state={state}
        me={me}
        online={online}
        inPerson={inPerson}
        features={features}
      />
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
    // M-A13 #5: 'padding' on Android too — the edge-to-edge window is not resized by the
    // keyboard, so the inline access-code / name inputs need the same lift as on iOS.
    <KeyboardAvoidingView style={styles.fill} behavior="padding">
      <Stepper step={state.step} onStep={onStepLabel} />
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
