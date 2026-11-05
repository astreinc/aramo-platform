// M-A12 W1-E.1 — My profile (prototype "My profile"): the user's own Sign profile.
// Display name is required; every other field is optional. The profile pre-fills the
// Name, First / Last name, Email, Company and Title fields when this user signs.
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { useOnline, useSenderContext } from '../../features/inbox/queries';
import {
  DISPLAY_NAME_MAX,
  draftFromProfile,
  PROFILE_FIELD_MAX,
  PROFILE_ROWS,
  profileBody,
  profileKeys,
  saveProfile,
  useSignProfile,
  validateProfile,
  type ProfileDraft,
} from '../../features/profile/signProfile';
import { TextField } from '../../features/send/ui';
import { useTheme } from '../../theme';

export function ProfileScreen() {
  const t = useTheme();
  const ctx = useSenderContext();
  const profile = useSignProfile();
  if (profile.isPending) {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading your profile" />
      </View>
    );
  }
  return (
    <ProfileForm
      initial={draftFromProfile(profile.data ?? null, ctx.data?.user.display_name ?? '')}
      email={ctx.data?.user.email ?? null}
    />
  );
}

export function ProfileForm({ initial, email }: { readonly initial: ProfileDraft; readonly email: string | null }) {
  const t = useTheme();
  const navigation = useNavigation();
  const toast = useToast();
  const qc = useQueryClient();
  const { workspace } = useServices();
  const online = useOnline();
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const errors = tried ? validateProfile(draft) : {};
  const set = (k: keyof ProfileDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  async function save(): Promise<void> {
    setTried(true);
    if (Object.keys(validateProfile(draft)).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveProfile(workspace, profileBody(draft));
      qc.setQueryData(profileKeys.profile, saved);
      toast.show('Profile saved');
      navigation.goBack();
    } catch (e) {
      setError(isApiError(e) ? refusalMessage(e) : 'Couldn’t save your profile. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        testID="profile-screen"
        style={{ flex: 1, backgroundColor: t.color.screen }}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {!online ? <OfflineBanner /> : null}
        <Text style={{ color: t.color.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: t.font.family }}>
          Used to fill in your name, company and title when you sign. Only you can see and change it.
        </Text>
        {email ? (
          <Text style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>
            {`Email: ${email}`}
          </Text>
        ) : null}
        <TextField
          testID="profile-display_name"
          label="Name"
          value={draft.display_name}
          onChangeText={set('display_name')}
          maxLength={DISPLAY_NAME_MAX}
          autoCapitalize="words"
          error={errors.display_name ?? null}
        />
        {PROFILE_ROWS.map((row) => (
          <TextField
            key={row.key}
            testID={`profile-${row.key}`}
            label={row.label}
            hint="(optional)"
            placeholder={row.placeholder}
            value={draft[row.key]}
            onChangeText={set(row.key)}
            maxLength={PROFILE_FIELD_MAX}
            autoCapitalize={row.key === 'country' ? 'characters' : 'words'}
            keyboardType={row.key === 'phone' ? 'phone-pad' : 'default'}
            error={errors[row.key] ?? null}
          />
        ))}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontSize: 14 }}>
            {error}
          </Text>
        ) : null}
        <Button
          testID="profile-save"
          title="Save"
          busy={busy}
          disabled={!online || draft.display_name.trim().length === 0}
          onPress={() => void save()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 12, paddingBottom: 48 },
});
