// Templates (M-A4 §6.4), opened from the side menu. Shell placeholder: title only; the
// Templates slice fills the list (backend-returned templates, Use -> Send flow step 2).
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HomeBackLink } from '../../features/shell/HomeBackLink';
import { useTheme } from '../../theme';

export function TemplatesScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen, paddingTop: insets.top }}>
      <ScrollView>
        <HomeBackLink />
        <Text
          accessibilityRole="header"
          style={{
            marginHorizontal: 16,
            marginTop: 2,
            color: t.color.text,
            fontFamily: t.font.family,
            ...t.type.largeTitle,
          }}
        >
          Templates
        </Text>
      </ScrollView>
    </View>
  );
}
