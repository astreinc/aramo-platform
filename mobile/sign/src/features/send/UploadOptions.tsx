// FIELD-PARITY-2 A-3 (G-4) — the Send flow's upload options: the same two choices as sign-web
// ("Import fields from a fillable PDF", "Apply text tags"), in the shared words
// (@aramo/sign-client over @aramo/sign-fields). Both start off; a chosen one goes with each
// document added from then on (and those still waiting for upload) as its upload flag.
import { StyleSheet, Text, View } from 'react-native';

import { TEXT_TAG_HELP, UPLOAD_OPTION_COPY } from '@aramo/sign-client';

import { useTheme } from '../../theme';
import { CheckRow } from '../inbox/ui';
import type { UploadOptions as Options } from './draftModel';

const KEYS = [
  ['importFields', 'import_fields'],
  ['applyTextTags', 'apply_text_tags'],
] as const;

export function UploadOptions({ value, onChange }: { readonly value: Options; readonly onChange: (v: Options) => void }) {
  const t = useTheme();
  const muted = { color: t.color.textSecondary, fontFamily: t.font.family };
  return (
    <View testID="upload-options" style={styles.wrap}>
      <Text accessibilityRole="header" style={[styles.head, muted]}>
        When uploading
      </Text>
      {KEYS.map(([k, wire]) => (
        <CheckRow
          key={k}
          testID={`upload-opt-${wire}`}
          checked={value[k]}
          onToggle={() => onChange({ ...value, [k]: !value[k] })}
          accessibilityLabel={UPLOAD_OPTION_COPY[wire].label}
        >
          <View style={styles.text}>
            <Text style={{ color: t.color.text, fontSize: 15, fontFamily: t.font.family }}>{UPLOAD_OPTION_COPY[wire].label}</Text>
            <Text style={[styles.help, muted]}>{UPLOAD_OPTION_COPY[wire].help}</Text>
          </View>
        </CheckRow>
      ))}
      {value.applyTextTags ? (
        <Text testID="upload-tag-help" style={[styles.help, muted]}>
          {`Tags look like ${TEXT_TAG_HELP.syntax}, for example ${TEXT_TAG_HELP.examples[0]}.`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  head: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  text: { flex: 1, gap: 2 },
  help: { fontSize: 13, lineHeight: 18 },
});
