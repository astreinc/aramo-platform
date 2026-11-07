// M-A14 §1 item 8 — after "Done" on You've Signed the app is on Agreements (All); if the
// inbox has an item the user can sign, "Want to sign another document?" is offered
// (SignNextModal renders nothing otherwise). Sign Next opens that item in the existing
// received-signing flow (the same route Tasks and Home use).
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';

import type { RootStackParamList } from '../../navigation/types';
import { SignNextModal } from '../../screens/selfSign/finish';
import { dismissSignNext, signNextRequested, subscribeSignNext } from './selfSignHandoff';

export function SignNextHost() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [open, setOpen] = useState(signNextRequested);
  useEffect(() => subscribeSignNext(setOpen), []);
  return (
    <SignNextModal
      visible={open}
      onClose={dismissSignNext}
      onSignNext={(item) => {
        dismissSignNext();
        navigation.navigate('Signing', { envelopeId: item.id });
      }}
    />
  );
}
