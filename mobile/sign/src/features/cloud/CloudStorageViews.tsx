// SIGN-FREE-PARITY-1 S6 (FP-R7) — Account → Connected storage and "Save to cloud storage" on a
// completed envelope (see cloudStorage.ts). Both render nothing while the server offers no
// provider (sender context `cloud_storage`, dark by default).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useTheme } from '../../theme';
import { useSenderContext } from '../inbox/queries';
import { SectionTitle, SettingRow } from '../inbox/ui';
import type { CloudProviderId } from '@aramo/sign-client';

import {
  CLOUD_STORAGE_COPY,
  cloudKeys,
  cloudProvidersOf,
  connectCloudProvider,
  connectOutcomeMessage,
  disconnectCloudProvider,
  loadCloudProviders,
  saveSignedCopyToCloud,
  type OpenAuthSession,
} from './cloudStorage';

// Ephemeral: the provider's sign-in does not share the browser's cookies.
const defaultOpenAuth: OpenAuthSession = (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect, { preferEphemeralSession: true });

function useCloudProviders(enabled: boolean) {
  const { workspace } = useServices();
  return useQuery({ queryKey: cloudKeys.all, queryFn: () => loadCloudProviders(workspace), enabled });
}

function useConnect(openAuth: OpenAuthSession) {
  const { workspace } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  return async (provider: CloudProviderId): Promise<void> => {
    try {
      const outcome = await connectCloudProvider(workspace, provider, openAuth);
      const message = connectOutcomeMessage(outcome, provider);
      if (message !== null) toast.show(message);
    } catch (e) {
      toast.show(isApiError(e) ? refusalMessage(e) : CLOUD_STORAGE_COPY.failed);
    } finally {
      void qc.invalidateQueries({ queryKey: cloudKeys.all });
    }
  };
}

export function CloudStorageSection({ online, openAuth = defaultOpenAuth }: { readonly online: boolean; readonly openAuth?: OpenAuthSession }) {
  const t = useTheme();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useServices();
  const ctx = useSenderContext();
  const offered = cloudProvidersOf(ctx.data).length > 0;
  const providers = useCloudProviders(offered);
  const connect = useConnect(openAuth);
  const [busy, setBusy] = useState<CloudProviderId | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<CloudProviderId | null>(null);
  if (!offered) return null;
  const rows = providers.data ?? [];

  async function disconnect(p: CloudProviderId): Promise<void> {
    setBusy(p);
    try {
      await disconnectCloudProvider(workspace, p);
      setDisconnectTarget(null);
      void qc.invalidateQueries({ queryKey: cloudKeys.all });
    } catch (e) {
      setDisconnectTarget(null);
      toast.show(isApiError(e) ? refusalMessage(e) : CLOUD_STORAGE_COPY.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <View testID="cloud-storage-section">
      <SectionTitle>{CLOUD_STORAGE_COPY.settings_title}</SectionTitle>
      <Card style={{ marginHorizontal: 16 }}>
        {providers.isError ? <SettingRow title="Connected storage couldn’t be loaded." last /> : null}
        {rows.map((r, i) => (
          <SettingRow
            key={r.provider}
            testID={`cloud-row-${r.provider}`}
            title={r.label}
            subtitle={r.connected ? (r.account_label ?? 'Connected') : CLOUD_STORAGE_COPY.not_connected}
            trailing={
              <Button
                testID={r.connected ? `cloud-disconnect-${r.provider}` : `cloud-connect-${r.provider}`}
                title={r.connected ? CLOUD_STORAGE_COPY.disconnect : CLOUD_STORAGE_COPY.connect}
                variant="text"
                disabled={!online || busy !== null}
                accessibilityLabel={`${r.connected ? CLOUD_STORAGE_COPY.disconnect : CLOUD_STORAGE_COPY.connect} ${r.label}`}
                onPress={() => {
                  if (r.connected) setDisconnectTarget(r.provider);
                  else {
                    setBusy(r.provider);
                    void connect(r.provider).finally(() => setBusy(null));
                  }
                }}
              />
            }
            last={i === rows.length - 1}
          />
        ))}
      </Card>
      <Text style={{ color: t.color.textSecondary, fontSize: 13, marginHorizontal: 20, marginTop: 6 }}>{CLOUD_STORAGE_COPY.settings_intro}</Text>
      <Sheet visible={disconnectTarget !== null} onClose={() => setDisconnectTarget(null)} title={CLOUD_STORAGE_COPY.disconnect}>
        <Text style={{ color: t.color.textSecondary, fontSize: 15, lineHeight: 21 }}>{CLOUD_STORAGE_COPY.disconnect_confirm}</Text>
        <Button
          testID="cloud-disconnect-confirm"
          title={CLOUD_STORAGE_COPY.disconnect}
          variant="destructive"
          busy={busy !== null}
          onPress={() => disconnectTarget && void disconnect(disconnectTarget)}
        />
        <Button title="Cancel" variant="text" onPress={() => setDisconnectTarget(null)} />
      </Sheet>
    </View>
  );
}

/** "Save to cloud storage" for a completed envelope (the screen shows it with Download). */
export function SaveToCloudButton({ envelopeId, online, openAuth = defaultOpenAuth }: { readonly envelopeId: string; readonly online: boolean; readonly openAuth?: OpenAuthSession }) {
  const ctx = useSenderContext();
  const { workspace } = useServices();
  const toast = useToast();
  const offered = cloudProvidersOf(ctx.data).length > 0;
  const [open, setOpen] = useState(false);
  const providers = useCloudProviders(offered && open);
  const connect = useConnect(openAuth);
  const [busy, setBusy] = useState<CloudProviderId | null>(null);
  if (!offered) return null;

  async function save(p: CloudProviderId): Promise<void> {
    setBusy(p);
    try {
      const out = await saveSignedCopyToCloud(workspace, envelopeId, p);
      setOpen(false);
      toast.show(CLOUD_STORAGE_COPY.saved(p, out.folder.name));
    } catch (e) {
      toast.show(isApiError(e) ? refusalMessage(e) : CLOUD_STORAGE_COPY.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button testID="action-save-cloud" title="Save to cloud storage" variant="secondary" disabled={!online} onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title="Save the signed copy">
        {(providers.data ?? []).map((r) => (
          <Button
            key={r.provider}
            testID={r.connected ? `cloud-save-${r.provider}` : `cloud-connect-${r.provider}`}
            title={r.connected ? CLOUD_STORAGE_COPY.save_to(r.provider) : `${CLOUD_STORAGE_COPY.connect} ${r.label}`}
            variant={r.connected ? 'secondary' : 'text'}
            busy={busy === r.provider}
            disabled={!online || busy !== null}
            onPress={() => {
              if (r.connected) void save(r.provider);
              else {
                setBusy(r.provider);
                void connect(r.provider).finally(() => setBusy(null));
              }
            }}
          />
        ))}
        <Text style={{ fontSize: 13, opacity: 0.7 }}>{CLOUD_STORAGE_COPY.save_folder_default}</Text>
        <Button title="Cancel" variant="text" onPress={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
