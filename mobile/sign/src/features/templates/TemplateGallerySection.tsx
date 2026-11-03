// Aramo-TEMPLATE-PRODUCT-1 §8.5 (R6-M) — "Aramo templates" on the Templates screen: the Aramo
// templates for Aramo Sign this account has not adopted, each with **Use as it is** (one call:
// adopt + approve unchanged) when the backend offers it, else "Ask an admin to approve this
// template". Editing is never done here: "Adopt and edit on desktop". Use-only, no editor.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useTheme } from '../../theme';
import {
  ASK_ADMIN,
  EDIT_ON_DESKTOP,
  GALLERY_INTRO,
  GALLERY_TITLE,
  loadTemplateGallery,
  asIsRefusalMessage,
  adoptTemplateAsIs,
  type GalleryTemplate,
} from './gallery';
import { templateLibraryKey } from './useTemplates';

export const templateGalleryKey = ['sign', 'sender', 'templates', 'gallery'] as const;

export function TemplateGallerySection({ offerAsIs, disabled }: { readonly offerAsIs: boolean; readonly disabled?: boolean }) {
  const t = useTheme();
  const qc = useQueryClient();
  const { workspace } = useServices();
  const gallery = useQuery({ queryKey: templateGalleryKey, queryFn: () => loadTemplateGallery(workspace) });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ readonly id: string; readonly text: string } | null>(null);

  const use = async (g: GalleryTemplate) => {
    setBusy(g.id);
    setMessage(null);
    try {
      await adoptTemplateAsIs(workspace, g.id);
      setMessage({ id: g.id, text: `“${g.name}” is ready to use in your templates.` });
      void qc.invalidateQueries({ queryKey: templateGalleryKey });
      void qc.invalidateQueries({ queryKey: templateLibraryKey });
    } catch (e) {
      setMessage({ id: g.id, text: asIsRefusalMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const items = gallery.data ?? [];
  if (gallery.isPending || gallery.isError || items.length === 0) return null;
  const secondary = { color: t.color.textSecondary, fontSize: 13, lineHeight: 18, fontFamily: t.font.family };
  return (
    <View style={styles.section} testID="template-gallery">
      <Text style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.rowTitle }}>{GALLERY_TITLE}</Text>
      <Text style={secondary}>{GALLERY_INTRO}</Text>
      <Card>
        {items.map((g, i) => (
          <View
            key={g.id}
            testID={`gallery-${i}`}
            style={[styles.row, i < items.length - 1 ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator } : null]}
          >
            <View style={styles.text}>
              <Text style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.rowTitle }}>{g.name}</Text>
              {g.documentType ? <Text style={secondary}>{g.documentType}</Text> : null}
              {g.description ? <Text style={secondary}>{g.description}</Text> : null}
              {message?.id === g.id ? (
                <Text style={[secondary, { color: t.color.text }]} accessibilityLiveRegion="polite">
                  {message.text}
                </Text>
              ) : null}
            </View>
            {offerAsIs ? (
              <Button
                title="Use as it is"
                onPress={() => void use(g)}
                busy={busy === g.id}
                disabled={!!disabled || busy !== null}
                accessibilityLabel={`Use ${g.name} as it is`}
                testID={`use-as-is-${i}`}
              />
            ) : (
              <Text style={[secondary, styles.note]}>{ASK_ADMIN}</Text>
            )}
          </View>
        ))}
      </Card>
      <Text style={secondary}>{EDIT_ON_DESKTOP}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  note: { maxWidth: 140, textAlign: 'right' },
});
