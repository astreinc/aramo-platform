// Aramo Sign mobile — Expo app config (Directive Aramo-Sign-Mobile-Native-Application-
// Implementation-Directive-v1_0 §2; M-A1 §3.1; M-A2 §3.1).
//
// Native projects (ios/, android/) are GENERATED from this file by `expo prebuild` and
// checked in. Change identity, links or plugins HERE, then re-run `npm run prebuild`.
import type { ExpoConfig } from 'expo/config';

const SIGN_HOST = 'sign.aramo.ai';

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
    // Only what the app uses: camera for the document scanner, biometrics for local
    // unlock/confirmation, notifications for push. No storage-wide permissions: the
    // system picker (Storage Access Framework) grants per-file access.
    permissions: [
      'android.permission.CAMERA',
      'android.permission.USE_BIOMETRIC',
      'android.permission.POST_NOTIFICATIONS',
    ],
    blockedPermissions: [
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
        android: { minSdkVersion: 29 },
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
  ],
  extra: {
    // Non-secret, build-time public configuration (see src/config/env.ts). The native
    // Cognito client is PUBLIC (no secret, PKCE S256, M-A1 §3.1); nothing secret ships.
    signHost: SIGN_HOST,
  },
};

export default config;
