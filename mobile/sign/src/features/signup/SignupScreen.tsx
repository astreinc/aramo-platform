// The signed-out "Create a free account" screen (M-A11 §1, §4): wires the native signup
// flow to the app's services. Android only (D-2): without Play Integrity (another
// platform, or a build with no EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER) the flow shows
// that creating an account isn't available and never calls start.
import { useMemo } from 'react';

import { useServices } from '../../app/ServicesContext';
import { createIntegritySession } from './integrity';
import { integrityModule } from './integrityModule';
import { SignupFlow } from './SignupFlow';

export function SignupScreen() {
  const { signup, env, signIn } = useServices();
  const integrity = useMemo(
    () =>
      integrityModule !== null && env.signPlayCloudProjectNumber !== null
        ? createIntegritySession(integrityModule, env.signPlayCloudProjectNumber)
        : null,
    [env.signPlayCloudProjectNumber],
  );
  return (
    <SignupFlow api={signup} integrity={integrity} signInWithGoogle={() => signIn('google')} />
  );
}
