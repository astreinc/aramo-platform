// Read-only document viewer (handoff §4.5): real PDF pages, no bottom bar, no Finish,
// nothing tappable.
//   kind 'source'      — a sender document's frozen source PDF
//                        (GET /v1/sign/sender/envelopes/{id}/documents/{documentId}/source,
//                        streamed by the native renderer with the workspace Bearer)
//   kind 'executed'    — executed documents of a COMPLETED envelope (base64 contract)
//   kind 'certificate' — the certificate of completion of a COMPLETED envelope
// Executed bytes are not persisted in the query cache.
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { CONSUMER, CONSUMER_HEADER } from '../../api/workspaceClient';
import { useServices } from '../../app/ServicesContext';
import { OfflineBanner } from '../../components/Banner';
import { useEnvelopeDetail, useOnline } from '../../features/inbox/queries';
import { EmptyState, Segments } from '../../features/inbox/ui';
import { ExecutedCopyView, type ExecutedPart } from '../../features/signing/ExecutedCopyView';
import { PdfPages } from '../../features/signing/PdfPages';
import { ZoomablePages } from '../../features/signing/ZoomablePages';
import type { RootStackParamList } from '../../navigation/types';
import { useAppSwitcherProtection } from '../../security/sensitiveScreen';
import { useTheme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DocumentViewer'>;

function ExecutedViewer({
  envelopeId,
  kind,
  documentId,
}: {
  envelopeId: string;
  kind: 'executed' | 'certificate';
  documentId?: string;
}) {
  const t = useTheme();
  const { workspace } = useServices();
  const q = useQuery({
    queryKey: ['sign', 'sender', 'envelope', envelopeId, 'executed-bytes'],
    queryFn: () =>
      workspace.call('/v1/sign/sender/envelopes/{id}/executed', 'get', {
        path: { id: envelopeId },
      }),
    gcTime: 60_000,
  });
  if (q.isPending)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={t.color.accent} />
      </View>
    );
  if (!q.data)
    return (
      <EmptyState
        title="Couldn’t load the signed copy"
        body={
          isApiError(q.error) ? refusalMessage(q.error) : 'Check your connection and try again.'
        }
      />
    );
  const parts: ExecutedPart[] = [
    ...(q.data.documents ?? []).map((d) => ({
      key: d.envelope_document_id,
      title: d.title,
      base64: d.executed_base64,
    })),
    ...(q.data.certificate?.certificate_base64
      ? [
          {
            key: 'certificate',
            title: 'Certificate',
            base64: q.data.certificate.certificate_base64,
          },
        ]
      : []),
  ];
  const initialKey = kind === 'certificate' ? 'certificate' : (documentId ?? parts[0]?.key);
  return <ExecutedCopyView parts={parts} {...(initialKey ? { initialKey } : {})} />;
}

function SourceViewer({ envelopeId, documentId }: { envelopeId: string; documentId?: string }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const { session, env } = useServices();
  const detail = useEnvelopeDetail(envelopeId);
  const docs = [...(detail.data?.detail.documents ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const [current, setCurrent] = useState<string | undefined>(documentId);
  const [token, setToken] = useState<string | null>(null);
  const selected = current ?? docs[0]?.id;
  useEffect(() => {
    let live = true;
    void session.getAccessToken().then((tk) => {
      if (live) setToken(tk);
    });
    return () => {
      live = false;
    };
  }, [session, selected]);
  if (!selected || !token)
    return (
      <View style={styles.center}>
        {detail.isPending || !token ? (
          <ActivityIndicator color={t.color.accent} />
        ) : (
          <EmptyState title="No documents" body="This envelope has no documents yet." />
        )}
      </View>
    );
  const doc = docs.find((d) => d.id === selected);
  const uri = `${env.apiBaseUrl}/v1/sign/sender/envelopes/${encodeURIComponent(envelopeId)}/documents/${encodeURIComponent(selected)}/source`;
  return (
    <View style={{ flex: 1 }}>
      {docs.length > 1 ? (
        <View style={[styles.switcher, { backgroundColor: t.color.screen }]}>
          <Segments
            items={docs.map((d) => ({ key: d.id, label: d.title }))}
            value={selected}
            onChange={setCurrent}
          />
        </View>
      ) : null}
      <ZoomablePages contentContainerStyle={styles.pages}>
        <PdfPages
          key={selected}
          source={{
            kind: 'remote',
            uri,
            headers: {
              Authorization: `Bearer ${token}`,
              [CONSUMER_HEADER]: CONSUMER,
              Accept: 'application/pdf',
            },
          }}
          width={Math.max(200, width - 24)}
          title={doc?.title ?? 'Document'}
        />
      </ZoomablePages>
    </View>
  );
}

export function DocumentViewerScreen({ route, navigation }: Props) {
  const { envelopeId, documentId, kind = 'source' } = route.params;
  const t = useTheme();
  const online = useOnline();
  useAppSwitcherProtection(true);
  useEffect(() => {
    navigation.setOptions({ title: kind === 'certificate' ? 'Certificate' : 'Documents' });
  }, [navigation, kind]);
  return (
    <View style={{ flex: 1, backgroundColor: t.color.documentBackdrop }}>
      {!online ? (
        <View style={{ padding: 12 }}>
          <OfflineBanner />
        </View>
      ) : null}
      {kind === 'source' ? (
        <SourceViewer envelopeId={envelopeId} {...(documentId ? { documentId } : {})} />
      ) : (
        <ExecutedViewer
          envelopeId={envelopeId}
          kind={kind}
          {...(documentId ? { documentId } : {})}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  pages: { paddingVertical: 12, alignItems: 'center' },
  switcher: { paddingVertical: 8 },
});
