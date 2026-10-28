// M-A7 §4 R-6 / R-13: the release build never signs with the debug key, the generated
// android/ project matches the config plugin, and R8 is on for release.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyReleaseSigning } = require('../../../plugins/withReleaseSigning.js') as {
  applyReleaseSigning: (src: string) => string;
};

const root = join(__dirname, '../../..');
const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');

function releaseBlock(src: string): string {
  const start = src.indexOf('        release {', src.indexOf('    buildTypes {'));
  return src.slice(start, src.indexOf('\n        }', start));
}

describe('release signing (M-A7 R-6)', () => {
  it('the checked-in build.gradle is what the plugin generates (idempotent)', () => {
    expect(applyReleaseSigning(gradle)).toBe(gradle);
  });

  it('release signs with the upload key or nothing, never the debug key', () => {
    const release = releaseBlock(gradle);
    expect(release).toContain('signingConfig aramoHasUploadKey ? signingConfigs.release : null');
    expect(release).not.toContain('signingConfigs.debug');
    expect(gradle).toContain('throw new GradleException(aramoMissingSigningMessage)');
  });

  it('reads the upload key from properties or environment, never from the repo', () => {
    for (const name of [
      'ARAMO_UPLOAD_STORE_FILE',
      'ARAMO_UPLOAD_STORE_PASSWORD',
      'ARAMO_UPLOAD_KEY_ALIAS',
      'ARAMO_UPLOAD_KEY_PASSWORD',
    ])
      expect(gradle).toContain(`aramoSigningValue('${name}')`);
    expect(readFileSync(join(root, 'android/gradle.properties'), 'utf8')).not.toMatch(
      /ARAMO_UPLOAD_/,
    );
  });

  it('turns a stock Expo template into the fail-closed form', () => {
    const stock = gradle
      .replace(
        /[ \t]*\/\/ @aramo-release-signing begin[\s\S]*?\/\/ @aramo-release-signing end\n\n?/g,
        '',
      )
      .replace(
        /( {8}release \{\n)[^\n]*\n[^\n]*signingConfig aramoHasUploadKey[^\n]*\n/,
        '$1            // Caution! In production, you need to generate your own keystore file.\n            // see https://reactnative.dev/docs/signed-apk-android.\n            signingConfig signingConfigs.debug\n',
      );
    expect(releaseBlock(stock)).toContain('signingConfigs.debug');
    expect(applyReleaseSigning(stock)).toBe(gradle);
  });
});

describe('R8 for release (M-A7 R-13)', () => {
  it('minify and resource shrinking are on', () => {
    const props = readFileSync(join(root, 'android/gradle.properties'), 'utf8');
    expect(props).toMatch(/^android\.enableMinifyInReleaseBuilds=true$/m);
    expect(props).toMatch(/^android\.enableShrinkResourcesInReleaseBuilds=true$/m);
    expect(readFileSync(join(root, 'android/app/proguard-rules.pro'), 'utf8')).toContain(
      '-keep class io.legere.pdfiumandroid.** { *; }',
    );
  });
});

describe('permissions (M-A7 R-5)', () => {
  it('blocks CAMERA, READ_MEDIA_IMAGES and DETECT_SCREEN_CAPTURE in the app manifest', () => {
    const manifest = readFileSync(join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    for (const p of ['CAMERA', 'READ_MEDIA_IMAGES', 'DETECT_SCREEN_CAPTURE'])
      expect(manifest).toContain(
        `<uses-permission android:name="android.permission.${p}" tools:node="remove"/>`,
      );
  });
});
