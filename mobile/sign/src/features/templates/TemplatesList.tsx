// Templates screen content (M-A4 §6.4; handoff §2A "Templates"), opened from the side
// menu. It lists the templates the backend returns with only their returned metadata.
// **Use** asks for the template's sender values (the existing sender-variable form),
// creates the draft through the existing from-template route, then opens the Send flow
// at step 2 on that draft. No template editing on mobile. A template WITH signing roles
// (M-A6 §3.5, FEATURES.multiRoleTemplates) is bound role by role first, and the flow
// opens on Review when the server bound everything, else on Recipients (landingStep).
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { signKeys, useOnline } from '../inbox/queries';
import { EmptyState } from '../inbox/ui';
import { createFromTemplate, type RoleBindingRequest, type SenderTemplate } from '../send/templates';
import { landingStep } from './roleBindingModel';
import { TemplateRows } from './TemplateRows';
import { TemplateUseForm } from './TemplateUseForm';
import { TEMPLATES_FOOTNOTE, TEMPLATES_INTRO } from './templatesModel';
import { useTemplatesView } from './useTemplates';

export function TemplatesList() {
  const t = useTheme();
  const online = useOnline();
  const qc = useQueryClient();
  const { workspace } = useServices();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { view, refetch, refreshing } = useTemplatesView();
  const [template, setTemplate] = useState<SenderTemplate | null>(null);

  const create = async (values: Record<string, string>, idempotencyKey: string, binding?: RoleBindingRequest) => {
    if (!template) return;
    const v = await createFromTemplate(workspace, {
      templateId: template.id,
      values,
      idempotencyKey,
      ...(binding ? { binding } : {}),
    });
    setTemplate(null);
    void qc.invalidateQueries({ queryKey: signKeys.senderList });
    navigation.navigate('SendFlow', { envelopeId: v.env.id, step: binding ? landingStep(v.env) : 'recipients' });
  };

  const text = { color: t.color.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: t.font.family };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.color.screen }}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetch} />}
    >
      {!online ? <OfflineBanner /> : null}
      <Text style={text}>{TEMPLATES_INTRO}</Text>
      {view.kind === 'loading' ? (
        <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading templates" style={styles.loading} />
      ) : view.kind === 'unavailable' ? (
        <EmptyState title="Templates aren’t available" body={view.message} />
      ) : view.kind === 'error' ? (
        <View style={styles.center}>
          <EmptyState title="Templates couldn’t be loaded" body={view.message} />
          <Button title="Try again" variant="secondary" onPress={refetch} />
        </View>
      ) : view.kind === 'empty' ? (
        <>
          <EmptyState title="No templates" body={view.message} />
          {view.note ? <Text style={text}>{view.note}</Text> : null}
        </>
      ) : (
        <>
          <TemplateRows rows={view.rows} onUse={setTemplate} disabled={!online} />
          {view.note ? <Text style={text}>{view.note}</Text> : null}
        </>
      )}
      <Text style={text}>{TEMPLATES_FOOTNOTE}</Text>
      <Sheet visible={template !== null} onClose={() => setTemplate(null)} title={template?.name ?? 'Template'}>
        {template ? (
          <TemplateUseForm
            key={template.id}
            template={template}
            onCreate={create}
            onCancel={() => setTemplate(null)}
            onRolesChanged={refetch}
          />
        ) : null}
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, padding: 16, paddingBottom: 48 },
  loading: { marginTop: 32 },
  center: { gap: 12 },
});
