// Templates (M-A4 §6.4), opened from the side menu: the templates the backend returns,
// "Use" pre-fills the Send flow. No editing on mobile. TemplatesList owns its scroll
// view and pull-to-refresh.
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HomeBackLink } from '../../features/shell/HomeBackLink';
import { TemplatesList } from '../../features/templates/TemplatesList';
import { useTheme } from '../../theme';

export function TemplatesScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.color.screen, paddingTop: insets.top }}>
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
      <TemplatesList />
    </View>
  );
}
