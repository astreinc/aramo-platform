// The signed-out "Create a free account" screen (M-A11 §1, §4): wires the native signup
// flow to the app's services. Android uses Play Integrity (needs
// EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER); iOS uses App Attest (Apple Go-Live R-9 / W5).
// Without either (another platform, a build without the Play project number, or a device
// without App Attest) the flow shows that creating an account isn't available and never
// calls start. R-5: "Continue with Apple" prefills the email and name.
import { useMemo } from 'react';

import { useServices } from '../../app/ServicesContext';
import { integritySessionFor } from './integrity';
import { integrityModule } from './integrityModule';
import { SignupFlow } from './SignupFlow';

export function SignupScreen() {
  const { signup, env, signIn, appleSignupIdentity } = useServices();
  const integrity = useMemo(
    () => integritySessionFor(integrityModule, env.signPlayCloudProjectNumber),
    [env.signPlayCloudProjectNumber],
  );
  return (
    <SignupFlow
      api={signup}
      integrity={integrity}
      signIn={(provider) => signIn(provider)}
      appleIdentity={appleSignupIdentity}
    />
  );
}
