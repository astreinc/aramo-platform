// Templates screen content (M-A4 §6.4; handoff §2A "Templates"), opened from the side
// menu. It lists the templates the backend returns with only their returned metadata.
// **Use** asks for the template's sender values (the existing sender-variable form),
// creates the draft through the existing from-template route, then opens the Send flow
// at step 2 on that draft. No template editing on mobile. A template WITH signing roles
// (M-A6 §3.5, FEATURES.multiRoleTemplates) is bound role by role first, and the flow
// opens on Review when the server bound everything, else on Recipients (landingStep).
// TEMPLATE-PRODUCT-1 §8.5 (R6-M) — below the list, the Aramo templates not yet adopted, each
// with "Use as it is" (TemplateGallerySection); any other change is made on desktop.
// M-A12 W1-F: search, My templates / Shared tabs (only from the server's `ownership`), a
// per-user star (PUT/DELETE …/favorite; favorites list first), Personal copy without
// "organization", and for Personal Free the Standard prompt with View plans.
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
import { signKeys, useOnline, useRecheckOnline, useSenderContext } from '../inbox/queries';
import { EmptyState, Segments } from '../inbox/ui';
import {
  createFromTemplate,
  setTemplateFavorite,
  type RoleBindingRequest,
  type SenderTemplate,
  type TemplateLibrary,
} from '../send/templates';
import { canUseAsIs } from './gallery';
import { landingStep } from './roleBindingModel';
import { TemplateGallerySection } from './TemplateGallerySection';
import { TemplateRows } from './TemplateRows';
import { TemplateUseForm } from './TemplateUseForm';
import {
  filterTemplateRows,
  hasOwnership,
  templatesCopy,
  type TemplateTab,
} from './templatesModel';
import { templateLibraryKey, useTemplatesView } from './useTemplates';
import { TextField } from '../send/ui';
import { useToast } from '../../components/Toast';

export function TemplatesList() {
  const t = useTheme();
  const online = useOnline();
  const recheckOnline = useRecheckOnline();
  const qc = useQueryClient();
  const { workspace } = useServices();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { view, refetch, refreshing } = useTemplatesView();
  // TEMPLATE-PRODUCT-1 §8.5 — the backend's "Use as it is" signal (cached context query).
  const context = useSenderContext();
  const [template, setTemplate] = useState<SenderTemplate | null>(null);
  // M-A12 W1-F — search, My / Shared, favorites.
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<TemplateTab>('mine');
  const toast = useToast();
  const copy = templatesCopy(context.data);
  const toggleFavorite = async (tpl: SenderTemplate) => {
    const on = tpl.favorite !== true;
    const flip = (lib: TemplateLibrary | undefined): TemplateLibrary | undefined =>
      lib && lib.kind === 'ok'
        ? { ...lib, items: lib.items.map((x) => (x.id === tpl.id ? { ...x, favorite: on } : x)) }
        : lib;
    qc.setQueryData<TemplateLibrary>(templateLibraryKey, flip);
    try {
      await setTemplateFavorite(workspace, tpl.id, on);
    } catch {
      qc.setQueryData<TemplateLibrary>(templateLibraryKey, (lib) =>
        lib && lib.kind === 'ok'
          ? { ...lib, items: lib.items.map((x) => (x.id === tpl.id ? { ...x, favorite: !on } : x)) }
          : lib,
      );
      toast.show('Couldn’t update favorites. Try again.');
    }
  };

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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void Promise.allSettled([recheckOnline(), refetch()])} />}
    >
      {!online ? <OfflineBanner /> : null}
      {view.kind === 'upsell' ? null : <Text style={text}>{copy.intro}</Text>}
      {view.kind === 'upsell' ? (
        <View style={styles.center} testID="templates-upsell">
          <Text style={{ color: t.color.text, fontSize: 17, lineHeight: 23, fontFamily: t.font.family }}>
            {view.message}
          </Text>
          <Button
            testID="templates-view-plans"
            title="View plans"
            onPress={() => navigation.navigate('Plans', { from: 'templates' })}
          />
        </View>
      ) : view.kind === 'loading' ? (
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
          <TextField
            testID="templates-search"
            label="Search templates"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            returnKeyType="search"
          />
          {hasOwnership(view.rows) ? (
            <Segments
              items={[
                { key: 'mine', label: 'My templates' },
                { key: 'shared', label: 'Shared' },
              ]}
              value={tab}
              onChange={setTab}
              testIDPrefix="templates-tab"
            />
          ) : null}
          {filterTemplateRows(view.rows, query, tab).length > 0 ? (
            <TemplateRows
              rows={filterTemplateRows(view.rows, query, tab)}
              onUse={setTemplate}
              disabled={!online}
              onToggleFavorite={(tpl) => void toggleFavorite(tpl)}
            />
          ) : (
            <EmptyState title="No matches" body="Try a different search." />
          )}
          {view.note ? <Text style={text}>{view.note}</Text> : null}
        </>
      )}
      {view.kind === 'list' || view.kind === 'empty' ? (
        <TemplateGallerySection offerAsIs={canUseAsIs(context.data)} disabled={!online} />
      ) : null}
      {view.kind === 'upsell' ? null : <Text style={text}>{copy.footnote}</Text>}
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
