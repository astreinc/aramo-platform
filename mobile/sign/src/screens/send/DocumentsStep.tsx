// Step 1 "What do you want to send?" (handoff §4.6; directive §5).
//   - The Personal limit banner first, when it applies (from the billing account).
//   - Scan a document (native scanner -> one PDF).
//   - Choose a file (system picker). PDF only; a Word file is refused with a message.
//   - Or start from a template: only while the backend reports sign.templates as
//     available (C-17). Hidden otherwise.
// Picking any source moves to step 2.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useServices } from '../../app/ServicesContext';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ListRow, RowTile } from '../../components/ListRow';
import { Sheet } from '../../components/Sheet';
import { newIdempotencyKey } from '../../api/workspaceClient';
import type { LimitBanner } from '../../features/inbox/allowance';
import type { SendFlowController, SendFlowState } from '../../features/send/sendFlowController';
import { pickPdf, scanToPdf, type SourceResult } from '../../features/send/sources';
import {
  createFromTemplate,
  listTemplates,
  type SenderTemplate,
} from '../../features/send/templates';
import { ErrorText, StepTitle, TextField } from '../../features/send/ui';
import { useTheme } from '../../theme';

const ICON_SCAN = 'M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 12h10';
const ICON_FILE = 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6';

function SourceCard({
  title,
  body,
  icon,
  onPress,
  disabled,
}: {
  readonly title: string;
  readonly body: string;
  readonly icon: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Card>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${body}`}
        accessibilityState={{ disabled: !!disabled }}
        style={[styles.source, { minHeight: t.size.minTouch + 28, opacity: disabled ? 0.42 : 1 }]}
      >
        <RowTile background={t.color.tint} color={t.color.accent}>
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={t.color.accent} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <Path d={icon} />
          </Svg>
        </RowTile>
        <View style={styles.sourceText}>
          <Text style={{ color: t.color.text, fontSize: 17, fontWeight: '600', fontFamily: t.font.family }}>{title}</Text>
          <Text style={{ color: t.color.textSecondary, fontSize: 14, fontFamily: t.font.family }}>{body}</Text>
        </View>
      </Pressable>
    </Card>
  );
}

export function DocumentsStep({
  controller,
  state,
  limit,
  templatesEnabled,
  onPicked,
}: {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
  readonly limit: LimitBanner | null;
  /** The backend's sign.templates availability + permission (never derived here). */
  readonly templatesEnabled: boolean;
  readonly onPicked: () => void;
}) {
  const t = useTheme();
  const { workspace } = useServices();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [template, setTemplate] = useState<SenderTemplate | null>(null);
  const docs = state.draft?.payload.documents ?? [];
  const canUseTemplate = templatesEnabled && docs.length === 0 && !state.draft?.envelopeId;
  const templates = useQuery({
    queryKey: ['sign', 'sender', 'templates'],
    queryFn: () => listTemplates(workspace),
    enabled: canUseTemplate,
  });

  const take = async (get: () => Promise<SourceResult>) => {
    setRefusal(null);
    let r: SourceResult;
    try {
      r = await get();
    } catch {
      setRefusal('That source isn’t available on this phone.');
      return;
    }
    if (r.kind === 'cancelled') return;
    if (r.kind === 'refused') {
      setRefusal(r.message);
      return;
    }
    await controller.addDocument({
      title: r.title,
      filename: r.filename,
      bytes: r.bytes,
      ...(r.pages ? { pages: r.pages } : {}),
    });
    if (!controller.snapshot.error) onPicked();
  };

  const busy = state.busy === 'adding';
  return (
    <View style={styles.body}>
      {limit ? <Banner title={limit.title} body={limit.body} /> : null}
      <StepTitle>What do you want to send?</StepTitle>
      <SourceCard
        title="Scan a document"
        body="Use the camera. Edges are found for you."
        icon={ICON_SCAN}
        disabled={busy}
        onPress={() => void take(scanToPdf)}
      />
      <SourceCard
        title="Choose a file"
        body="A PDF from this phone, OneDrive or Google Drive"
        icon={ICON_FILE}
        disabled={busy}
        onPress={() => void take(pickPdf)}
      />
      <ErrorText>{refusal ?? state.error}</ErrorText>

      {canUseTemplate && templates.data && templates.data.length > 0 ? (
        <>
          <Text accessibilityRole="header" style={[styles.section, { color: t.color.textSecondary }]}>
            Or start from a template
          </Text>
          <Card>
            {templates.data.map((tpl, i) => (
              <ListRow
                key={tpl.id}
                title={tpl.name}
                subtitle={tpl.documentType || undefined}
                onPress={() => setTemplate(tpl)}
                showSeparator={i < (templates.data?.length ?? 0) - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      {docs.length > 0 ? (
        <>
          <Text accessibilityRole="header" style={[styles.section, { color: t.color.textSecondary }]}>
            Documents
          </Text>
          <Card>
            {docs.map((d, i) => (
              <View
                key={d.key}
                style={[
                  styles.docRow,
                  i < docs.length - 1 ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator } : null,
                ]}
              >
                <View style={styles.docText}>
                  <Text numberOfLines={2} style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }}>
                    {d.title}
                  </Text>
                  <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
                    {[
                      d.pages ? `${d.pages.length} ${d.pages.length === 1 ? 'page' : 'pages'}` : null,
                      d.pendingUpload ? 'Not uploaded yet' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Button
                  title="Remove"
                  variant="text"
                  accessibilityLabel={`Remove ${d.title}`}
                  onPress={() => void controller.removeDocument(d.key)}
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <TemplateSheet
        key={template?.id ?? 'none'}
        template={template}
        onClose={() => setTemplate(null)}
        onCreate={async (values, idempotencyKey) => {
          if (!template) return;
          const v = await createFromTemplate(workspace, {
            templateId: template.id,
            values,
            idempotencyKey,
          });
          await controller.adoptTemplateEnvelope(v);
          setTemplate(null);
          onPicked();
        }}
      />
    </View>
  );
}

function TemplateSheet({
  template,
  onClose,
  onCreate,
}: {
  readonly template: SenderTemplate | null;
  readonly onClose: () => void;
  readonly onCreate: (values: Record<string, string>, idempotencyKey: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  // One key per pick, reused when the sender retries (the render is idempotent on it).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const create = useMutation({ mutationFn: () => onCreate(values, idempotencyKey) });
  return (
    <Sheet visible={template !== null} onClose={onClose} title={template?.name ?? 'Template'}>
      {template?.senderVariables.map((v) => (
        <TextField
          key={v.key}
          label={v.label}
          value={values[v.key] ?? ''}
          onChangeText={(x) => setValues((s) => ({ ...s, [v.key]: x }))}
        />
      ))}
      <ErrorText>{create.isError ? 'The template couldn’t be used. Try again.' : null}</ErrorText>
      <Button title="Use template" busy={create.isPending} onPress={() => create.mutate()} />
      <Button title="Cancel" variant="text" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, padding: 16 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  sourceText: { flex: 1, gap: 2 },
  section: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginTop: 8, marginLeft: 4 },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 4, paddingVertical: 8 },
  docText: { flex: 1, minWidth: 0, gap: 2 },
});
