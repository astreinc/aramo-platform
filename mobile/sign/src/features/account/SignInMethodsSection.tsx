// Account → Sign-in methods (Apple Go-Live A1 L-3 path 1, L-4, L-7): the providers linked
// to this account, "Add <provider>" (the OS auth session with that provider, then
// POST /auth/native/sign/link with the Bearer token: proof (c)) and "Remove" (refused with
// last_sign_in_method when it is the only one). The server applies the attach policy and
// sends the security email; refusals show provider-neutral copy.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { SignInMethod } from '../../api/apple-contract-types';
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { PROVIDER_NAMES, type Provider } from '../../auth/authorize';
import { ProviderLogo } from '../../components/BrandMarks';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useTheme } from '../../theme';
import { SectionTitle, SettingRow } from '../inbox/ui';
import {
  addableProviders,
  loadSignInMethods,
  removeSignInMethod,
  SIGN_IN_METHODS_COPY,
  signInMethodKeys,
} from './signInMethods';

export function useSignInMethods() {
  const { workspace } = useServices();
  return useQuery({ queryKey: signInMethodKeys.all, queryFn: () => loadSignInMethods(workspace) });
}

export function SignInMethodsSection({ online }: { readonly online: boolean }) {
  const t = useTheme();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace, linkProvider } = useServices();
  const methods = useSignInMethods();
  const [busy, setBusy] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Provider | null>(null);
  const items: readonly SignInMethod[] = methods.data ?? [];
  const addable = methods.data ? addableProviders(items) : [];

  async function add(p: Provider): Promise<void> {
    setBusy(`add-${p}`);
    try {
      await linkProvider(p);
      toast.show(SIGN_IN_METHODS_COPY.added(p));
      void qc.invalidateQueries({ queryKey: signInMethodKeys.all });
    } catch (e) {
      if (isApiError(e) && e.reason === 'auth_cancelled') return;
      toast.show(isApiError(e) ? refusalMessage(e) : SIGN_IN_METHODS_COPY.failed);
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: Provider): Promise<void> {
    setBusy(`remove-${p}`);
    try {
      await removeSignInMethod(workspace, p);
      setRemoveTarget(null);
      toast.show(SIGN_IN_METHODS_COPY.removed(p));
      void qc.invalidateQueries({ queryKey: signInMethodKeys.all });
    } catch (e) {
      setRemoveTarget(null);
      toast.show(isApiError(e) ? refusalMessage(e) : SIGN_IN_METHODS_COPY.failed);
    } finally {
      setBusy(null);
    }
  }

  const rows = [
    ...items.map((m) => ({ kind: 'linked' as const, m })),
    ...addable.map((p) => ({ kind: 'add' as const, p })),
  ];
  return (
    <View testID="sign-in-methods">
      <SectionTitle>{SIGN_IN_METHODS_COPY.title}</SectionTitle>
      <Card style={{ marginHorizontal: 16 }}>
        {methods.isError ? <SettingRow title={SIGN_IN_METHODS_COPY.loadFailed} last /> : null}
        {rows.map((r, i) =>
          r.kind === 'linked' ? (
            <SettingRow
              key={`linked-${r.m.idp}`}
              testID={`sign-in-method-${r.m.idp}`}
              title={PROVIDER_NAMES[r.m.idp]}
              {...(r.m.email_snapshot ? { subtitle: r.m.email_snapshot } : {})}
              trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ProviderLogo provider={r.m.idp} size={14} />
                  <Button
                    testID={`sign-in-method-remove-${r.m.idp}`}
                    title={SIGN_IN_METHODS_COPY.remove}
                    variant="text"
                    disabled={!online || busy !== null}
                    accessibilityLabel={`Remove ${PROVIDER_NAMES[r.m.idp]}`}
                    onPress={() => setRemoveTarget(r.m.idp)}
                  />
                </View>
              }
              last={i === rows.length - 1}
            />
          ) : (
            <SettingRow
              key={`add-${r.p}`}
              testID={`sign-in-method-add-${r.p}`}
              title={SIGN_IN_METHODS_COPY.add(r.p)}
              trailing={<ProviderLogo provider={r.p} size={14} />}
              onPress={() => void add(r.p)}
              disabled={!online || busy !== null}
              last={i === rows.length - 1}
            />
          ),
        )}
      </Card>
      <Sheet
        visible={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={removeTarget ? SIGN_IN_METHODS_COPY.removeTitle(removeTarget) : ''}
      >
        <Text style={{ color: t.color.textSecondary, fontSize: 15, lineHeight: 21 }}>
          {removeTarget ? SIGN_IN_METHODS_COPY.removeBody(removeTarget) : ''}
        </Text>
        <Button
          testID="sign-in-method-remove-confirm"
          title={SIGN_IN_METHODS_COPY.remove}
          variant="destructive"
          busy={busy?.startsWith('remove-') ?? false}
          onPress={() => removeTarget && void remove(removeTarget)}
        />
        <Button title="Cancel" variant="text" onPress={() => setRemoveTarget(null)} />
      </Sheet>
    </View>
  );
}
