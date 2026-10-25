// Optional local unlock of the stored session (M-A1 §4). Local only: no server call.
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { confirmLocally } from '../../auth/biometric';
import { Button } from '../../components/Button';
import { useTheme } from '../../theme';

export function UnlockScreen({ onUnlocked }: { readonly onUnlocked: () => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const attempt = useCallback(() => {
    setBusy(true);
    void confirmLocally('Unlock Aramo Sign')
      .then((ok) => {
        if (ok) onUnlocked();
      })
      .finally(() => setBusy(false));
  }, [onUnlocked]);
  useEffect(() => {
    const id = setTimeout(attempt, 0);
    return () => clearTimeout(id);
  }, [attempt]);
  return (
    <View style={[styles.fill, { backgroundColor: t.color.white }]}>
      <Text
        accessibilityRole="header"
        style={[{ color: t.color.text, fontFamily: t.font.family }, t.type.appTitle]}
      >
        Aramo Sign
      </Text>
      <Button title="Unlock" onPress={attempt} busy={busy} style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  button: { alignSelf: 'stretch' },
});
