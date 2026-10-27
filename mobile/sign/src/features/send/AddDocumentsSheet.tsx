// Add documents sheet (M-A4 §5; handoff §2A "Add documents sheet"; prototype `shAdd`).
// A grid of outlined circles: **Scan** (native scanner), **Photos** (photo library -> one
// PDF, A12), **Templates** (only while the backend reports sign.templates as available
// and the session may use them, C-17) and **Files** (the system picker: a PDF from this
// phone, OneDrive or Google Drive). PDF only (A11).
//
// Not built (M-A4 §5.4): Email-in, Google Drive, OneDrive, Box, Dropbox and AI tiles.
// They are not rendered in any build.
//
// Every source adds its document through the Send flow controller, exactly as step 1
// did before. Templates are picked inside this sheet (rows, then the sender-variable
// form) and become this flow's draft through the existing from-template route.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useTheme } from '../../theme';
import { EmptyState } from '../inbox/ui';
import { TemplateRows } from '../templates/TemplateRows';
import { TemplateValuesForm } from '../templates/TemplateValuesForm';
import { useTemplatesView } from '../templates/useTemplates';
import { pickPhotosToPdf } from './photos';
import type { SendFlowController } from './sendFlowController';
import { pickPdf, scanToPdf, type SourceResult } from './sources';
import { createFromTemplate, type SenderTemplate } from './templates';
import { ErrorText } from './ui';

export const FILES_NOTE = 'A PDF from this phone, OneDrive or Google Drive';
export const SOURCE_UNAVAILABLE = 'That source isn’t available on this phone.';

export type AddSourceKey = 'scan' | 'photos' | 'templates' | 'files';

export interface AddSourceTile {
  readonly key: AddSourceKey;
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
}

const TILES: Record<AddSourceKey, AddSourceTile> = {
  scan: {
    key: 'scan',
    label: 'Scan',
    hint: 'Use the camera. Edges are found for you.',
    icon: 'M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 12h10',
  },
  photos: {
    key: 'photos',
    label: 'Photos',
    hint: 'Choose photos. They become one PDF.',
    icon: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
  },
  templates: {
    key: 'templates',
    label: 'Templates',
    hint: 'Start from a template your organization approved.',
    icon: 'M4 4h16v16H4zM4 9h16M9 9v11',
  },
  files: { key: 'files', label: 'Files', hint: FILES_NOTE, icon: 'M3 6h6l2 2h10v11H3z' },
};

/** The tiles, in the prototype's order. Templates only when the backend allows it. */
export function addSourceTiles(templatesEnabled: boolean): readonly AddSourceTile[] {
  return [TILES.scan, TILES.photos, ...(templatesEnabled ? [TILES.templates] : []), TILES.files];
}

/**
 * Run one source and add what it returns to the draft. Returns the refusal to show, or
 * null when the source was cancelled or the document was added.
 */
export async function addFromSource(
  controller: Pick<SendFlowController, 'addDocument' | 'snapshot'>,
  get: () => Promise<SourceResult>,
): Promise<{ readonly added: boolean; readonly refusal: string | null }> {
  let r: SourceResult;
  try {
    r = await get();
  } catch {
    return { added: false, refusal: SOURCE_UNAVAILABLE };
  }
  if (r.kind === 'cancelled') return { added: false, refusal: null };
  if (r.kind === 'refused') return { added: false, refusal: r.message };
  await controller.addDocument({
    title: r.title,
    filename: r.filename,
    bytes: r.bytes,
    ...(r.pages ? { pages: r.pages } : {}),
  });
  return { added: !controller.snapshot.error, refusal: null };
}

const RUN: Record<Exclude<AddSourceKey, 'templates'>, () => Promise<SourceResult>> = {
  scan: scanToPdf,
  photos: () => pickPhotosToPdf(),
  files: pickPdf,
};

function SourceTile({
  tile,
  disabled,
  onPress,
}: {
  readonly tile: AddSourceTile;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={tile.label}
      accessibilityHint={tile.hint}
      accessibilityState={{ disabled }}
      testID={`add-source-${tile.key}`}
      style={[styles.tile, { opacity: disabled ? 0.42 : 1 }]}
    >
      <View
        style={[
          styles.circle,
          { borderColor: t.platform === 'ios' ? t.color.text : (t.color.surfaceBorder ?? t.color.text), backgroundColor: t.color.surface },
        ]}
      >
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={t.color.text} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <Path d={tile.icon} />
        </Svg>
      </View>
      <Text style={{ color: t.color.text, fontSize: 14, fontWeight: '500', fontFamily: t.font.family, textAlign: 'center' }}>
        {tile.label}
      </Text>
    </Pressable>
  );
}

type Mode = { readonly kind: 'sources' } | { readonly kind: 'templates' } | { readonly kind: 'template'; readonly template: SenderTemplate };

export function AddDocumentsSheet({
  visible,
  onClose,
  controller,
  busy,
  error,
  templatesEnabled,
  onAdded,
}: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly controller: SendFlowController;
  /** The flow is already adding a document. */
  readonly busy: boolean;
  /** The flow's own error (e.g. the document couldn't be stored). */
  readonly error: string | null;
  /** sign.templates available + permitted (backend), and the draft can still start from one. */
  readonly templatesEnabled: boolean;
  /** A document (or a template draft) was added. */
  readonly onAdded: () => void;
}) {
  const t = useTheme();
  const { workspace } = useServices();
  const [mode, setMode] = useState<Mode>({ kind: 'sources' });
  const [running, setRunning] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const templates = useTemplatesView(visible && templatesEnabled && mode.kind !== 'sources');

  const close = () => {
    setMode({ kind: 'sources' });
    setRefusal(null);
    onClose();
  };

  const run = async (key: Exclude<AddSourceKey, 'templates'>) => {
    setRefusal(null);
    setRunning(true);
    try {
      const out = await addFromSource(controller, RUN[key]);
      if (out.refusal) setRefusal(out.refusal);
      if (out.added) {
        close();
        onAdded();
      }
    } finally {
      setRunning(false);
    }
  };

  const disabled = busy || running;
  const title =
    mode.kind === 'template' ? mode.template.name : mode.kind === 'templates' ? 'Templates' : 'Add documents';
  const view = templates.view;

  return (
    <Sheet visible={visible} onClose={close} title={title}>
      {mode.kind === 'sources' ? (
        <>
          <View style={styles.grid}>
            {addSourceTiles(templatesEnabled).map((tile) => (
              <SourceTile
                key={tile.key}
                tile={tile}
                disabled={disabled}
                onPress={() => (tile.key === 'templates' ? setMode({ kind: 'templates' }) : void run(tile.key))}
              />
            ))}
          </View>
          {disabled ? <ActivityIndicator color={t.color.accent} accessibilityLabel="Adding the document" /> : null}
          <ErrorText>{refusal ?? error}</ErrorText>
          <Text style={[styles.caption, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
            {`Files: ${FILES_NOTE}.`}
          </Text>
          <Button title="Close" variant="text" onPress={close} />
        </>
      ) : mode.kind === 'templates' ? (
        <>
          {view.kind === 'loading' ? (
            <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading templates" />
          ) : view.kind === 'list' ? (
            <TemplateRows rows={view.rows} onUse={(template) => setMode({ kind: 'template', template })} />
          ) : view.kind === 'empty' ? (
            <EmptyState title="No templates" body={view.message} />
          ) : (
            <EmptyState title="Templates aren’t available" body={view.message} />
          )}
          {(view.kind === 'list' || view.kind === 'empty') && view.note ? (
            <Text style={[styles.caption, { color: t.color.textSecondary, fontFamily: t.font.family }]}>{view.note}</Text>
          ) : null}
          <Button title="Back" variant="text" onPress={() => setMode({ kind: 'sources' })} />
        </>
      ) : (
        <TemplateValuesForm
          key={mode.template.id}
          template={mode.template}
          cancelTitle="Back"
          onCancel={() => setMode({ kind: 'templates' })}
          onCreate={async (values, idempotencyKey) => {
            const v = await createFromTemplate(workspace, {
              templateId: mode.template.id,
              values,
              idempotencyKey,
            });
            await controller.adoptTemplateEnvelope(v);
            close();
            onAdded();
          }}
        />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, paddingTop: 4 },
  tile: { width: '33.33%', alignItems: 'center', gap: 7, minHeight: 48 },
  circle: { width: 70, height: 70, borderRadius: 35, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  caption: { fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
});
