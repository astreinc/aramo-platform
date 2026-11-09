// Account (a root-stack screen opened from the side menu with a "‹ Home" back link;
// `section: 'settings'` scrolls to the Signing settings — M-A4 §1.4-§1.5; handoff §4.9 minus the account switcher — directive §7 C-10: one signed-in
// identity at a time; "Sign out to use another account"). Profile, account type,
// Personal plan and usage, default signature and initials, biometric confirmation and unlock, push
// preferences (incl. "Show subject on lock screen", default off), devices / sessions,
// legal re-acceptance, Delete account / Request deletion (M-A7 §3.3), About, Sign out.
// Remaining-Work A4 — "Manage billing or cancel" opens the web billing settings (owners of a billed plan).
// M-A12 W1-E: My profile, the date format and default field size settings, Report app
// issue, and the Plan row (W1-G Plans screen). A store-billed plan is managed in the store.
// Apple Go-Live: "Signed in with Apple" (R-2), Sign-in methods with Add / Remove (A1 L-7),
// and Apple token revocation on deletion (R-8).
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import {
  biometricCapability,
  biometricConfirmPref,
  biometricUnlockPref,
  confirmLocally,
  type BiometricCapability,
} from '../../auth/biometric';
import { Banner, OfflineBanner } from '../../components/Banner';
import { ProviderLogo } from '../../components/BrandMarks';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { WEB_LINKS } from '../../config/env';
import { ARAMO_SIGN_IDENTITY, PRIVACY_MAILTO, SUPPORT_MAILTO } from '../../config/identity';
import {
  deviceLabel,
  listSessions,
  revokeSession,
  type NativeSession,
} from '../../features/account/devices';
import { billingSettingsLink, MANAGE_BILLING_LABEL } from '../../features/account/billing';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { DateFormat, FieldSize } from '../../api/m-a12-contract-types';
import { planRowLabel } from '../../features/plans/plansModel';
import {
  DATE_FORMATS,
  DEFAULT_SETTINGS,
  FIELD_SIZES,
  formatDate,
  profileKeys,
  saveSettings,
  useSignSettings,
} from '../../features/profile/signProfile';
import { ReportIssueSheet } from '../../features/support/ReportIssueSheet';
import { appleLinked } from '../../features/account/appleRevoke';
import { DeleteAccountSection } from '../../features/account/DeleteAccountSection';
import {
  SignInMethodsSection,
  useSignInMethods,
} from '../../features/account/SignInMethodsSection';
import { isPersonalAccountOwner } from '../../features/account/privacy';
import { PrivacyRequestsSection } from '../../features/account/PrivacyRequestsSection';
import { signedInWithLabel } from '../../features/account/profile';
import {
  acceptPending,
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
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const settings = useSignSettings();
  const [settingSheet, setSettingSheet] = useState<'date' | 'size' | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  async function changeSetting(patch: { date_format?: DateFormat; default_field_size?: FieldSize }): Promise<void> {
    const next = { ...(settings.data ?? DEFAULT_SETTINGS), ...patch };
    qc.setQueryData(profileKeys.settings, next);
    setSettingSheet(null);
    try {
      qc.setQueryData(profileKeys.settings, await saveSettings(workspace, next));
    } catch {
      toast.show('Couldn’t save the setting. Try again.');
      void settings.refetch();
    }
  }
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
  // M-A8 §2.1 — only the tenant_owner of a PERSONAL tenant may delete their own account.
  const personalOwner = isPersonalAccountOwner(ctx.data, billing.data?.tenant_kind);
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

  const [bio, setBio] = useState<BiometricCapability | null>(null);
  const [bioOn, setBioOn] = useState(true);
  const [unlockOn, setUnlockOn] = useState(false);
  const [pushPermission, setPushPermission] = useState<
    'granted' | 'denied' | 'undetermined' | null
  >(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<NativeSession | null>(null);

  useEffect(() => {
    void biometricCapability().then(setBio, () => setBio(null));
    void biometricConfirmPref.get(kv).then(setBioOn, () => undefined);
    void biometricUnlockPref.get(kv).then(setUnlockOn, () => undefined);
    void Notifications.getPermissionsAsync().then(
      (p) => setPushPermission(p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied'),
      () => setPushPermission(null),
    );
  }, [kv]);

  const user = ctx.data?.user;
  const name = user?.display_name ?? user?.email ?? '';
  const provider = user?.identity_provider ?? null;
  const signedInWith = signedInWithLabel(provider);
  const methods = useSignInMethods();
  const allowance = allowanceModel(billing.data ?? null);
  // Remaining-Work A4 — cancel lives in the web billing settings; the app links there.
  const billingLink = billingSettingsLink(billing.data);
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
                {provider !== null ? <ProviderLogo provider={provider} size={14} /> : null}
                <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>{signedInWith}</Text>
              </View>
            ) : null}
          </View>
        </Card>

        <Card style={styles.card0}>
          <SettingRow
            testID="account-profile"
            title="My profile"
            subtitle="Name, title, company, address and phone"
            onPress={() => navigation.navigate('Profile')}
            last
          />
        </Card>

        <SignInMethodsSection online={online} />

        <SectionTitle>Account</SectionTitle>
        <Card style={styles.card0}>
          <SettingRow
            title={
              personal
                ? `Personal · ${billing.data?.subscription?.plan_name ?? 'Free'}`
                : `${ctx.data?.tenant?.name ?? 'Organization'} · Business`
            }
            subtitle="Sign out to use another account"
          />
          <SettingRow
            testID="account-plan"
            title="Plan"
            trailing={planRowLabel(billing.data ?? null)}
            onPress={() => navigation.navigate('Plans', { from: 'settings' })}
            last
          />
        </Card>

        {billingLink !== null ? (
          <>
            <SectionTitle>Subscription</SectionTitle>
            <Card style={styles.card}>
              <Text style={{ color: t.color.textSecondary, fontSize: 13 }}>
                Update payment details, see invoices or cancel your subscription in the billing settings on the web.
              </Text>
              <Button
                testID="account-manage-billing"
                title={MANAGE_BILLING_LABEL}
                variant="text"
                onPress={() => open(billingLink)}
                style={{ alignSelf: 'flex-start' }}
              />
            </Card>
          </>
        ) : null}

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
                onPress={() => open(WEB_LINKS.personalTerms)}
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
            />
          ) : null}
          {bio?.available ? (
            <SettingRow
              testID="biometric-unlock-toggle"
              title={`Unlock with ${bio.label}`}
              subtitle="Asked when you open the app and after 5 minutes away. Stays on this phone."
              value={unlockOn}
              onValueChange={(v) => {
                // Turning it on or off takes a successful check, so whoever holds an
                // unlocked phone can't switch it off.
                void confirmLocally(
                  v ? `Turn on unlock with ${bio.label}` : `Turn off unlock with ${bio.label}`,
                )
                  .catch(() => false)
                  .then(async (ok) => {
                    if (!ok) return;
                    await biometricUnlockPref.set(kv, v);
                    setUnlockOn(v);
                  });
              }}
              last
            />
          ) : null}
        </Card>

        <SectionTitle>Preferences</SectionTitle>
        <Card style={styles.card0}>
          <SettingRow
            testID="setting-date-format"
            title="Date format"
            subtitle="How Date signed appears on envelopes you send"
            trailing={(settings.data ?? DEFAULT_SETTINGS).date_format}
            onPress={() => setSettingSheet('date')}
            disabled={!online}
          />
          <SettingRow
            testID="setting-field-size"
            title="Default field size"
            subtitle="The starting size of fields you place"
            trailing={
              FIELD_SIZES.find((x) => x.key === (settings.data ?? DEFAULT_SETTINGS).default_field_size)?.label ??
              'Medium'
            }
            onPress={() => setSettingSheet('size')}
            disabled={!online}
            last
          />
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
          <SettingRow testID="about-report-issue" title="Report app issue" onPress={() => setIssueOpen(true)} />
          <SettingRow title="Privacy" onPress={() => open(WEB_LINKS.privacy)} />
          <SettingRow title="Terms" onPress={() => open(WEB_LINKS.terms)} />
          {/* M-A7 §5.1 (G-6) — the one identity block (config/identity.ts). */}
          <SettingRow
            testID="about-developer"
            title="Developer"
            subtitle={`${ARAMO_SIGN_IDENTITY.legalEntity}\n${ARAMO_SIGN_IDENTITY.postalAddress}`}
          />
          <SettingRow
            testID="about-support"
            title="Support"
            subtitle={ARAMO_SIGN_IDENTITY.supportEmail}
            onPress={() => void Linking.openURL(SUPPORT_MAILTO).catch(() => undefined)}
          />
          <SettingRow
            testID="about-privacy-contact"
            title="Privacy contact"
            subtitle={ARAMO_SIGN_IDENTITY.privacyEmail}
            onPress={() => void Linking.openURL(PRIVACY_MAILTO).catch(() => undefined)}
          />
          <SettingRow
            title="Version"
            trailing={Application.nativeApplicationVersion ?? '1.0'}
            last
          />
        </Card>

        {/* M-A8 §2 — Personal owners keep "Delete account"; Business users are organization-managed:
            no self-service delete, a "Privacy requests" entry instead. */}
        {ctx.data === undefined && billing.data === undefined ? null : personalOwner ? (
          <DeleteAccountSection
            personal
            online={online}
            appleLinked={appleLinked(provider, methods.data)}
          />
        ) : (
          <PrivacyRequestsSection online={online} />
        )}

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
        visible={settingSheet !== null}
        onClose={() => setSettingSheet(null)}
        title={settingSheet === 'date' ? 'Date format' : 'Default field size'}
      >
        {settingSheet === 'date'
          ? DATE_FORMATS.map((f) => (
              <SettingRow
                key={f}
                testID={`date-format-${f}`}
                title={f}
                subtitle={`Example: ${formatDate(new Date(2026, 10, 5), f)}`}
                trailing={(settings.data ?? DEFAULT_SETTINGS).date_format === f ? '✓' : ''}
                onPress={() => void changeSetting({ date_format: f })}
              />
            ))
          : FIELD_SIZES.map((f) => (
              <SettingRow
                key={f.key}
                testID={`field-size-${f.key}`}
                title={f.label}
                subtitle={f.hint}
                trailing={(settings.data ?? DEFAULT_SETTINGS).default_field_size === f.key ? '✓' : ''}
                onPress={() => void changeSetting({ default_field_size: f.key })}
              />
            ))}
      </Sheet>

      <ReportIssueSheet visible={issueOpen} onClose={() => setIssueOpen(false)} screen="Account" online={online} />

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
});
