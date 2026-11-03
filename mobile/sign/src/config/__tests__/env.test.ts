// M-A11: EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER has no default; absent or malformed →
// null, and native signup is unavailable in that build.
import { resolveEnv } from '../env';

describe('Play Integrity cloud project number', () => {
  it('has no default and accepts digits only', () => {
    expect(resolveEnv({}, false).signPlayCloudProjectNumber).toBeNull();
    expect(
      resolveEnv({ EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER: '  ' }, false)
        .signPlayCloudProjectNumber,
    ).toBeNull();
    expect(
      resolveEnv({ EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER: 'abc' }, false)
        .signPlayCloudProjectNumber,
    ).toBeNull();
    expect(
      resolveEnv({ EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER: ' 123456789012 ' }, false)
        .signPlayCloudProjectNumber,
    ).toBe('123456789012');
  });
});
