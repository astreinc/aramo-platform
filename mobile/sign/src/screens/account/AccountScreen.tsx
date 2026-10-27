// Account (a root-stack screen opened from the side menu with a "‹ Home" back link;
// `section: 'settings'` scrolls to the Signing settings — M-A4 §1.4-§1.5; handoff §4.9 minus the account switcher — directive §7 C-10: one signed-in
// identity at a time; "Sign out to use another account"). Profile, account type,
// Personal plan and usage, default signature and initials, biometric confirmation, push
// preferences (incl. "Show subject on lock screen", default off), devices / sessions,
// legal re-acceptance, Personal account close, About, Sign out.
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import {
  biometricCapability,
  biometricConfirmPref,
  type BiometricCapability,
} from '../../auth/biometric';
import { Banner, OfflineBanner } from '../../components/Banner';
import { GoogleLogo, MicrosoftLogo } from '../../components/BrandMarks';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { WEB_LINKS } from '../../config/env';
import {
  deviceLabel,
  listSessions,
  revokeSession,
  type NativeSession,
} from '../../features/account/devices';
import { signedInWithLabel } from '../../features/account/profile';
import {
  acceptPending,
  closeAccount,
  closeConfirmed,
  loadAccountStatus,
  loadLegalStatus,
} from '../../features/account/legal';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  PREFERENCE_ROWS,
  savePreferences,
  withPreference,
  type NotificationPreferences,
  type PreferenceKey,
} from '../../features/account/preferences';
import { dateTime, shortDate } from '../../features/inbox/agreementsModel';
import { allowanceModel } from '../../features/inbox/allowance';
import {
  OFFLINE_ACTION_REASON,
  useBillingAccount,
  useOnline,
  useSenderContext,
} from '../../features/inbox/queries';
import { ProgressBar, SectionTitle, SettingRow } from '../../features/inbox/ui';
import { notificationKeys } from '../../features/notifications/queries';
import {
  deleteDefaultMark,
  loadSavedMarks,
  saveDefaultMark,
  savedKindLabel,
  type AdoptTarget,
} from '../../features/signing/adopt';
import { AdoptSignatureSheet } from '../../features/signing/AdoptSignatureSheet';
import { HomeBackLink } from '../../features/shell/HomeBackLink';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';

const accountKeys = {
  saved: ['sign', 'me', 'signature'] as const,
  sessions: ['auth', 'native', 'sessions'] as const,
  legal: ['sign', 'legal', 'status'] as const,
  accountStatus: ['sign', 'account', 'status'] as const,
};

function open(url: string): void {
  void WebBrowser.openBrowserAsync(url).catch(() => undefined);
}

export function AccountScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const { workspace, kv, signOut } = useServices();
  const route = useRoute<RouteProp<RootStackParamList, 'Account'>>();
  const scrollRef = useRef<ScrollView>(null);
  // Side menu "Settings": scroll to the settings once their position is known.
  const wantsSettings = useRef(route.params?.section === 'settings');
  function settingsLaidOut(y: number): void {
    if (!wantsSettings.current) return;
    wantsSettings.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
  }
  const online = useOnline();
  const ctx = useSenderContext();
  const billing = useBillingAccount();
  const personal =
    ctx.data?.tenant?.kind === 'PERSONAL' || billing.data?.tenant_kind === 'PERSONAL';
  const saved = useQuery({ queryKey: accountKeys.saved, queryFn: () => loadSavedMarks(workspace) });
  const prefs = useQuery({
    queryKey: notificationKeys.prefs,
    queryFn: () => loadPreferences(workspace),
    meta: { persist: true },
  });
  const sessions = useQuery({
    queryKey: accountKeys.sessions,
    queryFn: () => listSessions(workspace),
  });
  const legal = useQuery({
    queryKey: accountKeys.legal,
    queryFn: () => loadLegalStatus(workspace),
    enabled: personal,
  });
  const accountStatus = useQuery({
    queryKey: accountKeys.accountStatus,
    queryFn: () => loadAccountStatus(workspace),
    enabled: personal,
  });

  const [bio, setBio] = useState<BiometricCapability | null>(null);
  const [bioOn, setBioOn] = useState(true);
  const [pushPermission, setPushPermission] = useState<
    'granted' | 'denied' | 'undetermined' | null
  >(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeText, setCloseText] = useState('');
  const [closeError, setCloseError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<NativeSession | null>(null);

  useEffect(() => {
    void biometricCapability().then(setBio, () => setBio(null));
    void biometricConfirmPref.get(kv).then(setBioOn, () => undefined);
    void Notifications.getPermissionsAsync().then(
      (p) => setPushPermission(p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied'),
      () => setPushPermission(null),
    );
  }, [kv]);

  const user = ctx.data?.user;
  const name = user?.display_name ?? user?.email ?? '';
  const provider = user?.identity_provider ?? null;
  const signedInWith = signedInWithLabel(provider);
  const allowance = allowanceModel(billing.data ?? null);
  const pending = legal.data?.pending ?? [];

  async function togglePref(key: PreferenceKey, value: boolean): Promise<void> {
    const current = prefs.data ?? DEFAULT_PREFERENCES;
    const body: NotificationPreferences = withPreference(current, key, value);
    qc.setQueryData(notificationKeys.prefs, body);
    try {
      qc.setQueryData(notificationKeys.prefs, await savePreferences(workspace, body));
    } catch (e) {
      qc.setQueryData(notificationKeys.prefs, current);
      toast.show(isApiError(e) ? refusalMessage(e) : 'Couldn’t save. Try again.');
    }
  }

  async function adopted(
    target: AdoptTarget,
    r: { mark: { dataUrl: string; method: 'TYPED' | 'DRAWN' }; typedName: string },
  ): Promise<void> {
    await saveDefaultMark(workspace, target, r.mark, r.typedName);
    setAdoptTarget(null);
    toast.show(target === 'SIGNATURE' ? 'Default signature saved' : 'Default initials saved');
    void qc.invalidateQueries({ queryKey: accountKeys.saved });
  }

  async function removeMark(target: AdoptTarget): Promise<void> {
    setBusy(`delete-${target}`);
    try {
      await deleteDefaultMark(workspace, target);
      void qc.invalidateQueries({ queryKey: accountKeys.saved });
    } catch {
      toast.show('Couldn’t remove it. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function doRevoke(s: NativeSession): Promise<void> {
    setBusy(`revoke-${s.device_session_id}`);
    try {
      const r = await revokeSession(workspace, s, signOut);
      setRevokeTarget(null);
      if (r !== 'revoked_current') {
        toast.show('Device signed out');
        void qc.invalidateQueries({ queryKey: accountKeys.sessions });
      }
    } catch (e) {
      toast.show(isApiError(e) ? refusalMessage(e) : 'Couldn’t sign that device out. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function accept(): Promise<void> {
    setBusy('legal');
    try {
      qc.setQueryData(accountKeys.legal, await acceptPending(workspace, pending));
      toast.show('Thanks — you’re up to date');
    } catch (e) {
      toast.show(isApiError(e) ? refusalMessage(e) : 'Couldn’t record that. Try again.');
      void legal.refetch();
    } finally {
      setBusy(null);
    }
  }

  async function doClose(): Promise<void> {
    setBusy('close');
    setCloseError(null);
    try {
      await closeAccount(workspace);
      setCloseOpen(false);
      await signOut();
    } catch (e) {
      setCloseError(isApiError(e) ? refusalMessage(e) : 'Couldn’t close the account. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const disabledReason = online ? undefined : OFFLINE_ACTION_REASON;

  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen }}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 40 }}
      >
        <HomeBackLink />
        <Text
          accessibilityRole="header"
          style={[
            styles.pad,
            { color: t.color.text, fontFamily: t.font.family, ...t.type.largeTitle },
          ]}
        >
          Account
        </Text>
        {!online ? (
          <View style={[styles.pad, { marginTop: 8 }]}>
            <OfflineBanner />
          </View>
        ) : null}

        <Card style={[styles.card, styles.profile]}>
          <View style={[styles.avatar, { backgroundColor: t.color.tint }]}>
            <Text style={{ color: t.color.onTint, fontSize: 20, fontWeight: '600' }}>
              {name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((p) => p[0]?.toUpperCase())
                .join('') || '·'}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.color.text, fontSize: 18, fontWeight: '600' }}>
              {user?.display_name ?? ''}
            </Text>
            {user?.email ? (
              <Text style={{ color: t.color.textSecondary, fontSize: 14 }}>{user.email}</Text>
            ) : null}
            {signedInWith ? (
              <View style={styles.provider} testID="signed-in-with">
                {provider === 'microsoft' ? <MicrosoftLogo size={14} /> : <GoogleLogo size={14} />}
                <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{signedInWith}</Text>
              </View>
            ) : null}
          </View>
        </Card>

        <SectionTitle>Account</SectionTitle>
        <Card style={styles.card0}>
          <SettingRow
            title={
              personal
                ? 'Personal · Free'
                : `${ctx.data?.tenant?.name ?? 'Organization'} · Business`
            }
            subtitle="Sign out to use another account"
            last
          />
        </Card>

        {personal && allowance ? (
          <>
            <SectionTitle>Plan and usage</SectionTitle>
            <Card style={styles.card}>
              {allowance.month ? (
                <View style={{ gap: 6 }}>
                  <Text
                    style={{ color: t.color.text, fontSize: 15 }}
                  >{`This month · ${allowance.month.used} of ${allowance.month.limit} used`}</Text>
                  <ProgressBar
                    fraction={allowance.month.used / Math.max(1, allowance.month.limit)}
                    color={allowance.month.remaining <= 0 ? t.color.destructive : t.color.accent}
                  />
                  {allowance.resetsAt ? (
                    <Text
                      style={{ color: t.color.textSecondary, fontSize: 13 }}
                    >{`Resets ${shortDate(allowance.resetsAt)}`}</Text>
                  ) : null}
                </View>
              ) : null}
              {allowance.day ? (
                <View style={{ gap: 6 }}>
                  <Text
                    style={{ color: t.color.text, fontSize: 15 }}
                  >{`Last 24 hours · ${allowance.day.used} of ${allowance.day.limit} used`}</Text>
                  <ProgressBar
                    fraction={allowance.day.used / Math.max(1, allowance.day.limit)}
                    color={allowance.day.remaining <= 0 ? t.color.destructive : t.color.accent}
                  />
                  {allowance.day.remaining <= 0 && allowance.nextAvailableAt ? (
                    <Text
                      style={{ color: t.color.textSecondary, fontSize: 13 }}
                    >{`You can send again at ${dateTime(allowance.nextAvailableAt)}`}</Text>
                  ) : null}
                </View>
              ) : null}
              <Button
                title="Free plan terms"
                variant="text"
                onPress={() => open(WEB_LINKS.terms)}
                style={{ alignSelf: 'flex-start' }}
              />
            </Card>
          </>
        ) : null}

        {pending.length > 0 ? (
          <View style={[styles.pad, { marginTop: 16, gap: 10 }]} testID="legal-pending">
            <Banner title="Updated terms" body="Accept the updated terms to keep sending." />
            {pending.map((p) => (
              <Button
                key={`${p.key}@${p.version}`}
                variant="text"
                title={`${p.title} (version ${p.version})`}
                onPress={() => open(p.url)}
                style={{ alignSelf: 'flex-start' }}
              />
            ))}
            <Button
              title="Accept"
              disabled={!online}
              busy={busy === 'legal'}
              accessibilityHint={disabledReason}
              onPress={() => void accept()}
            />
          </View>
        ) : null}

        <View testID="account-settings" onLayout={(e) => settingsLaidOut(e.nativeEvent.layout.y)}>
          <SectionTitle>Signing</SectionTitle>
        </View>
        <Card style={styles.card0}>
          <SettingRow
            testID="default-signature"
            title="Default signature"
            trailing={savedKindLabel(saved.data?.signature ?? null)}
            onPress={() => setAdoptTarget('SIGNATURE')}
            disabled={!online}
          />
          {saved.data?.signature ? (
            <SettingRow
              title="Remove default signature"
              destructive
              onPress={() => void removeMark('SIGNATURE')}
              disabled={!online || busy !== null}
            />
          ) : null}
          <SettingRow
            testID="default-initials"
            title="Default initials"
            trailing={savedKindLabel(saved.data?.initials ?? null)}
            onPress={() => setAdoptTarget('INITIALS')}
            disabled={!online}
            last={!saved.data?.initials && !bio?.available}
          />
          {saved.data?.initials ? (
            <SettingRow
              title="Remove default initials"
              destructive
              onPress={() => void removeMark('INITIALS')}
              disabled={!online || busy !== null}
              last={!bio?.available}
            />
          ) : null}
          {bio?.available ? (
            <SettingRow
              testID="biometric-toggle"
              title={`Confirm signing with ${bio.label}`}
              subtitle="Asked each time you finish signing. Stays on this phone."
              value={bioOn}
              onValueChange={(v) => {
                setBioOn(v);
                void biometricConfirmPref.set(kv, v);
              }}
              last
            />
          ) : null}
        </Card>

        <SectionTitle>Push notifications</SectionTitle>
        <Card style={styles.card0}>
          {pushPermission === 'denied' ? (
            <SettingRow
              title="Notifications are off for Aramo Sign"
              subtitle="Turn them on in Settings. Your in-app feed still works."
              onPress={() => void Linking.openSettings()}
            />
          ) : null}
          {PREFERENCE_ROWS.map((row, i) => (
            <SettingRow
              key={row.key}
              testID={`pref-${row.key}`}
              title={row.title}
              {...(row.subtitle ? { subtitle: row.subtitle } : {})}
              value={(prefs.data ?? DEFAULT_PREFERENCES)[row.key]}
              disabled={!online || !prefs.data}
              onValueChange={(v) => void togglePref(row.key, v)}
              last={i === PREFERENCE_ROWS.length - 1}
            />
          ))}
        </Card>

        <SectionTitle>Devices</SectionTitle>
        <Card style={styles.card0}>
          {(sessions.data ?? []).map((s, i, all) => (
            <SettingRow
              key={s.device_session_id}
              testID={`device-${s.device_session_id}`}
              title={deviceLabel(s)}
              subtitle={`Aramo Sign ${s.app_version} · last active ${dateTime(s.last_seen_at)}`}
              trailing={
                <Button
                  testID={`revoke-${s.device_session_id}`}
                  title="Sign out"
                  variant="text"
                  disabled={!online || busy !== null}
                  accessibilityLabel={`Sign out ${deviceLabel(s)}`}
                  onPress={() => setRevokeTarget(s)}
                />
              }
              last={i === all.length - 1}
            />
          ))}
          {sessions.isError ? (
            <SettingRow
              title="Couldn’t load your devices"
              subtitle="Pull to refresh or try again later."
              last
            />
          ) : null}
        </Card>

        <SectionTitle>About</SectionTitle>
        <Card style={styles.card0}>
          <SettingRow title="Help" onPress={() => open(WEB_LINKS.help)} />
          <SettingRow title="Privacy" onPress={() => open(WEB_LINKS.privacy)} />
          <SettingRow title="Terms" onPress={() => open(WEB_LINKS.terms)} />
          <SettingRow
            title="Version"
            trailing={Application.nativeApplicationVersion ?? '1.0'}
            last
          />
        </Card>

        {personal && accountStatus.data?.closable ? (
          <View style={[styles.pad, { marginTop: 24 }]}>
            <Button
              title="Close account"
              variant="destructive"
              disabled={!online}
              onPress={() => setCloseOpen(true)}
            />
          </View>
        ) : null}

        <View style={[styles.pad, { marginTop: 24 }]}>
          <Button
            testID="sign-out"
            title="Sign out"
            variant="destructive"
            busy={busy === 'signout'}
            onPress={() => {
              setBusy('signout');
              void signOut().finally(() => setBusy(null));
            }}
          />
        </View>
      </ScrollView>

      {adoptTarget ? (
        <AdoptSignatureSheet
          visible
          target={adoptTarget}
          mode="account"
          defaultName={user?.display_name ?? ''}
          canSaveDefault
          onAdopt={(r) => adopted(adoptTarget, r)}
          onClose={() => setAdoptTarget(null)}
        />
      ) : null}

      <Sheet
        visible={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Sign out this device?"
      >
        <Text style={{ color: t.color.textSecondary, fontSize: 15, lineHeight: 21 }}>
          {revokeTarget?.current
            ? 'This phone will be signed out now.'
            : 'That device is signed out and stops getting notifications. It needs to sign in again.'}
        </Text>
        <Button
          testID="revoke-confirm"
          title="Sign out device"
          variant="destructive"
          busy={busy?.startsWith('revoke-') ?? false}
          onPress={() => revokeTarget && void doRevoke(revokeTarget)}
        />
        <Button title="Cancel" variant="text" onPress={() => setRevokeTarget(null)} />
      </Sheet>

      <Sheet visible={closeOpen} onClose={() => setCloseOpen(false)} title="Close your account?">
        <Text style={{ color: t.color.textSecondary, fontSize: 15, lineHeight: 21 }}>
          Sending stops for good. Envelopes you already sent stay open for their signers. Type CLOSE
          to confirm.
        </Text>
        <TextInput
          testID="close-confirm-input"
          value={closeText}
          onChangeText={setCloseText}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="Type CLOSE to confirm"
          style={[
            styles.input,
            {
              borderColor: t.color.separator,
              color: t.color.text,
              backgroundColor: t.color.surface,
            },
          ]}
        />
        {closeError ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive }}>
            {closeError}
          </Text>
        ) : null}
        <Button
          title="Close account"
          variant="destructive"
          disabled={!closeConfirmed(closeText) || !online}
          busy={busy === 'close'}
          onPress={() => void doClose()}
        />
        <Button title="Cancel" variant="text" onPress={() => setCloseOpen(false)} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { marginHorizontal: 16 },
  card: { marginHorizontal: 16, padding: 14, gap: 12 },
  card0: { marginHorizontal: 16 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 16 },
  provider: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 17, minHeight: 48 },
});
