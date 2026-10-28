// Aramo Sign mobile — Expo app config (Directive Aramo-Sign-Mobile-Native-Application-
// Implementation-Directive-v1_0 §2; M-A1 §3.1; M-A2 §3.1).
//
// Native projects (ios/, android/) are GENERATED from this file by `expo prebuild` and
// checked in. Change identity, links or plugins HERE, then re-run `npm run prebuild`.
import type { ExpoConfig } from 'expo/config';

const SIGN_HOST = 'sign.aramo.ai';

// Release R8 keep rules (M-A7 §4 R-13), written into android/app/proguard-rules.pro.
const PROGUARD_RULES = `
# react-native-pdf: the PdfiumAndroid renderer (JNI) and the viewer it drives.
-keep class io.legere.pdfiumandroid.** { *; }
-keep class com.shockwave.pdfium.** { *; }
-keep class com.github.barteksc.pdfviewer.** { *; }
-keep class org.wonday.pdf.** { *; }
# react-native-blob-util (file writes / downloads used by the renderer and share sheet).
-keep class com.ReactNativeBlobUtil.** { *; }
-dontwarn com.ReactNativeBlobUtil.**
# Hermes and React Native native bridges reached from C++.
-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.facebook.react.bridge.** { *; }
# Expo modules are looked up by name at runtime.
-keep class expo.modules.** { *; }
-keep class * extends expo.modules.kotlin.modules.Module { *; }
# ML Kit document scanner (Play services) and the scanner plugin.
-keep class com.google.mlkit.vision.documentscanner.** { *; }
-keep class com.documentscanner.** { *; }
-dontwarn com.google.mlkit.**
`;

const config: ExpoConfig = {
  name: 'Aramo Sign',
  slug: 'aramo-sign',
  scheme: 'aramosign',
  version: '1.0.0',
  orientation: 'portrait',
  // The aramo mark on the Sign accent; regenerate with scripts/draw-app-icon.swift.
  icon: './assets/icon.png',
  platforms: ['ios', 'android'],
  ios: {
    bundleIdentifier: 'ai.aramo.sign',
    supportsTablet: false,
    // Universal Links: /s/*, /d/* and the native auth callback (served by the
    // apple-app-site-association file on the Sign host, directive P-1 / P-6).
    associatedDomains: [`applinks:${SIGN_HOST}`],
    infoPlist: {
      // ATS defaults stay in force: no arbitrary loads (directive §12.16).
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    },
  },
  android: {
    package: 'ai.aramo.sign',
    // Android App Links, verified against assetlinks.json on the Sign host (P-3 / P-6).
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: [
          { scheme: 'https', host: SIGN_HOST, pathPrefix: '/s/' },
          { scheme: 'https', host: SIGN_HOST, pathPrefix: '/d/' },
          { scheme: 'https', host: SIGN_HOST, path: '/auth/native/callback' },
        ],
      },
    ],
    // Only what the app uses: biometrics for local unlock/confirmation, notifications for
    // push. No storage-wide permissions: the system picker (Storage Access Framework) grants
    // per-file access and photos come through the Android Photo Picker.
    // No CAMERA on Android (M-A7 §4 R-5): the scanner is ML Kit GmsDocumentScanning, which
    // runs inside Google Play services with its own camera access. iOS (VisionKit) keeps its
    // camera usage string below. A real-device check of the Android scanner gates release.
    permissions: ['android.permission.USE_BIOMETRIC', 'android.permission.POST_NOTIFICATIONS'],
    // Merged in by libraries but unused on Android (M-A7 §4 R-5): READ_MEDIA_IMAGES and
    // DETECT_SCREEN_CAPTURE come from expo-screen-capture, which the app calls on iOS only
    // (src/security/sensitiveScreen.ts); CAMERA is listed by the image-picker / scanner plugins.
    blockedPermissions: [
      'android.permission.CAMERA',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.DETECT_SCREEN_CAPTURE',
      'android.permission.RECORD_AUDIO',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.DOWNLOAD_WITHOUT_NOTIFICATION',
    ],
    // No cloud backup of app files (encrypted drafts / cache). Tokens are already
    // excluded by expo-secure-store's backup rules.
    allowBackup: false,
  },
  plugins: [
    [
      'expo-build-properties',
      {
        // iOS 16.4 is the floor of the Expo SDK 57 module set (ExpoModulesCore.podspec);
        // see README "Versions" (directive §13 D-1).
        ios: { deploymentTarget: '16.4' },
        // R8 code shrinking + resource shrinking for release (M-A7 §4 R-13). Keep rules for
        // code reached only through JNI / reflection; most libraries ship consumer rules.
        android: {
          minSdkVersion: 29,
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          extraProguardRules: PROGUARD_RULES,
        },
      },
    ],
    'expo-secure-store',
    'expo-web-browser',
    [
      'expo-local-authentication',
      {
        faceIDPermission: 'Aramo Sign uses Face ID to confirm it’s you before you finish signing.',
      },
    ],
    ['expo-notifications', {}],
    [
      'react-native-document-scanner-plugin',
      { cameraPermission: 'Aramo Sign uses the camera to scan documents you choose to send.' },
    ],
    [
      // Photos source (M-A4 §5.2, A12): the system photo picker (PHPicker / Android Photo
      // Picker), so no library-wide or storage permission is requested on Android; the
      // storage permissions above stay blocked. The iOS usage string declares photo-library
      // access. Camera keeps the scanner's string; the microphone is never used.
      'expo-image-picker',
      {
        photosPermission:
          'Aramo Sign uses your photos only when you choose some to turn into a PDF to send.',
        cameraPermission: 'Aramo Sign uses the camera to scan documents you choose to send.',
        microphonePermission: false,
      },
    ],
    '@config-plugins/react-native-pdf',
    '@config-plugins/react-native-blob-util',
    // Release signs with the upload key from outside Git, or fails (M-A7 §4 R-6).
    './plugins/withReleaseSigning.js',
  ],
  extra: {
    // Non-secret, build-time public configuration (see src/config/env.ts). The native
    // Cognito client is PUBLIC (no secret, PKCE S256, M-A1 §3.1); nothing secret ships.
    signHost: SIGN_HOST,
  },
};

export default config;
