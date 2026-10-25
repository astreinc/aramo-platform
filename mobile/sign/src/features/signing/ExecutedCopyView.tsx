// Read-only executed documents + certificate of completion (handoff §4.5; directive §6
// "retrieve the executed document and certificate"). Pages render with the native PDF
// renderer; nothing can be tapped.
import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useTheme } from '../../theme';
import { shortDate } from '../inbox/agreementsModel';
import { EmptyState, Segments } from '../inbox/ui';
import { PdfPages } from './PdfPages';
import { ZoomablePages } from './ZoomablePages';

export interface ExecutedPart {
  readonly key: string;
  readonly title: string;
  readonly base64: string;
}

export function ExecutedCopyView({
  subject,
  completedAt,
  parts,
  initialKey,
}: {
  readonly subject?: string | null;
  readonly completedAt?: string | null;
  readonly parts: readonly ExecutedPart[];
  readonly initialKey?: string;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [key, setKey] = useState(initialKey ?? parts[0]?.key ?? '');
  const part = parts.find((p) => p.key === key) ?? parts[0];
  if (!part)
    return (
      <EmptyState title="Nothing to show" body="This envelope has no documents to show yet." />
    );
  return (
    <View style={{ flex: 1, backgroundColor: t.color.documentBackdrop }}>
      <View style={[styles.head, { backgroundColor: t.color.screen }]}>
        {subject ? (
          <Text
            accessibilityRole="header"
            style={{ color: t.color.text, fontSize: 17, fontWeight: '600' }}
          >
            {subject}
          </Text>
        ) : null}
        {completedAt ? (
          <Text
            style={{ color: t.color.textSecondary, fontSize: 13 }}
          >{`Completed ${shortDate(completedAt)}`}</Text>
        ) : null}
        {parts.length > 1 ? (
          <Segments
            items={parts.map((p) => ({ key: p.key, label: p.title }))}
            value={part.key}
            onChange={setKey}
          />
        ) : null}
      </View>
      <ZoomablePages contentContainerStyle={styles.pages}>
        <PdfPages
          key={part.key}
          source={{ kind: 'base64', base64: part.base64 }}
          width={Math.max(200, width - 24)}
          title={part.title}
        />
      </ZoomablePages>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  pages: { paddingVertical: 12, alignItems: 'center' },
});
