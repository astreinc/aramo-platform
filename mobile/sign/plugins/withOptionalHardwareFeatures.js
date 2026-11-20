// Play infers REQUIRED hardware features from the manifest:
//   - android:screenOrientation="portrait" (our activities + the ML Kit document
//     scanner delegate) → android.hardware.screen.portrait
//   - ACCESS_WIFI_STATE (merged from libraries) → android.hardware.wifi
// Required features hide the app from devices without them (tablets in landscape
// docks, Chromebooks, Android XR, devices without Wi-Fi) and Play Console blocks
// "Send for review". The app works without either, so declare them optional.
const { withAndroidManifest } = require('expo/config-plugins');

const OPTIONAL_FEATURES = ['android.hardware.screen.portrait', 'android.hardware.wifi'];

module.exports = function withOptionalHardwareFeatures(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] ?? [];
    for (const name of OPTIONAL_FEATURES) {
      const existing = manifest['uses-feature'].find((f) => f.$['android:name'] === name);
      if (existing) {
        existing.$['android:required'] = 'false';
      } else {
        manifest['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
      }
    }
    return cfg;
  });
};
