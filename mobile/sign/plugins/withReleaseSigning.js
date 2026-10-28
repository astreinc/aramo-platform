// Release signing for the Android app (Amendment M-A7 §4 R-6), as a config plugin so
// `expo prebuild` (including --clean) keeps it in android/app/build.gradle.
//
//   - The release build signs with the UPLOAD key, supplied outside Git as Gradle
//     properties (~/.gradle/gradle.properties or -P) or environment variables:
//       ARAMO_UPLOAD_STORE_FILE, ARAMO_UPLOAD_STORE_PASSWORD,
//       ARAMO_UPLOAD_KEY_ALIAS, ARAMO_UPLOAD_KEY_PASSWORD
//   - Without them a release build FAILS. It never falls back to the debug key.
//   - CI's no-secrets release regression build opts in with -Paramo.unsignedReleaseCheck=true
//     (or ARAMO_UNSIGNED_RELEASE_CHECK=true) and gets an UNSIGNED APK, which cannot be
//     installed or uploaded to Play.
//   - Debug builds keep the checked-in debug keystore.
// Production is signed by Google Play App Signing; see doc/runbooks/RELEASE-sign-mobile.md.
const { withAppBuildGradle } = require('expo/config-plugins');

const BEGIN = '// @aramo-release-signing begin (plugins/withReleaseSigning.js, DO NOT MODIFY)';
const END = '// @aramo-release-signing end';

const SETUP = `${BEGIN}
def aramoSigningValue = { String name -> (findProperty(name) ?: System.getenv(name))?.toString()?.trim() }
def aramoUploadKey = [
    storeFile    : aramoSigningValue('ARAMO_UPLOAD_STORE_FILE'),
    storePassword: aramoSigningValue('ARAMO_UPLOAD_STORE_PASSWORD'),
    keyAlias     : aramoSigningValue('ARAMO_UPLOAD_KEY_ALIAS'),
    keyPassword  : aramoSigningValue('ARAMO_UPLOAD_KEY_PASSWORD'),
]
def aramoHasUploadKey = aramoUploadKey.values().every { it }
def aramoUnsignedReleaseCheck = (aramoSigningValue('aramo.unsignedReleaseCheck') ?: aramoSigningValue('ARAMO_UNSIGNED_RELEASE_CHECK') ?: 'false').toBoolean()
def aramoMissingSigningMessage = "Aramo Sign release builds must be signed with the upload key, supplied outside Git. " +
    "Set ARAMO_UPLOAD_STORE_FILE, ARAMO_UPLOAD_STORE_PASSWORD, ARAMO_UPLOAD_KEY_ALIAS and ARAMO_UPLOAD_KEY_PASSWORD " +
    "as Gradle properties or environment variables (doc/runbooks/RELEASE-sign-mobile.md, P-3). " +
    "Release builds never fall back to the debug key."
// Fail before any task runs when a release variant is in the build, unless this is the
// explicit unsigned CI check.
gradle.taskGraph.whenReady { graph ->
    def wantsRelease = graph.allTasks.any { it.project == project && it.name == 'preReleaseBuild' }
    if (wantsRelease && !aramoHasUploadKey && !aramoUnsignedReleaseCheck) {
        throw new GradleException(aramoMissingSigningMessage)
    }
}
${END}`;

const SIGNING_CONFIG = `        ${BEGIN}
        if (aramoHasUploadKey) {
            release {
                storeFile file(aramoUploadKey.storeFile)
                storePassword aramoUploadKey.storePassword
                keyAlias aramoUploadKey.keyAlias
                keyPassword aramoUploadKey.keyPassword
            }
        }
        ${END}`;

const RELEASE_TEMPLATE =
  /(release \{\n)\s*\/\/ Caution! In production, you need to generate your own keystore file\.\n\s*\/\/ see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\n\s*signingConfig signingConfigs\.debug\n/;
const RELEASE_LINE = `$1            // Upload key from outside Git (M-A7 §4 R-6); never the debug key.
            signingConfig aramoHasUploadKey ? signingConfigs.release : null
`;

function stripBlocks(src) {
  const re = new RegExp(
    `[ \\t]*${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n\\n?`,
    'g',
  );
  return src.replace(re, '');
}

function applyReleaseSigning(src) {
  let out = stripBlocks(src);
  if (!/^android \{$/m.test(out)) throw new Error('withReleaseSigning: android { block not found');
  out = out.replace(/^android \{$/m, `${SETUP}\n\nandroid {`);
  if (!/^ {4}signingConfigs \{\n/m.test(out))
    throw new Error('withReleaseSigning: signingConfigs block not found');
  out = out.replace(/^( {4}signingConfigs \{\n)/m, `$1${SIGNING_CONFIG}\n`);
  if (RELEASE_TEMPLATE.test(out)) out = out.replace(RELEASE_TEMPLATE, RELEASE_LINE);
  if (!out.includes('signingConfig aramoHasUploadKey ? signingConfigs.release : null'))
    throw new Error('withReleaseSigning: release buildType signingConfig not found');
  return out;
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== 'groovy')
      throw new Error('withReleaseSigning: expected a Groovy app/build.gradle');
    c.modResults.contents = applyReleaseSigning(c.modResults.contents);
    return c;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
