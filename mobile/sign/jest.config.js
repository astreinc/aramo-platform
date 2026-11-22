// Client Rule Consolidation C2-3 / C2-5 — the libs/sign-client specs run here too (the SAME
// files vitest runs on the web side), so a rule change is tested on both runtimes.
// FIELD-PARITY-1 P1-1 — likewise libs/sign-fields (the one field catalog, which
// libs/sign-client imports and re-exports).
const signClientSrc = '<rootDir>/../../libs/sign-client/src';
const signFieldsSrc = '<rootDir>/../../libs/sign-fields/src';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', signClientSrc, signFieldsSrc],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.ts?(x)',
    `${signClientSrc}/__tests__/**/*.test.ts`,
    `${signFieldsSrc}/__tests__/**/*.test.ts`,
  ],
  moduleNameMapper: {
    '^@aramo/sign-client$': `${signClientSrc}/index.ts`,
    '^@aramo/sign-fields$': `${signFieldsSrc}/index.ts`,
  },
  // The libraries live outside this package, so Babel helpers they are compiled with (e.g.
  // @babel/runtime) must resolve from THIS package's node_modules: CI installs only
  // mobile/sign, never the repo root, so walking up from libs/sign-client finds nothing.
  modulePaths: ['<rootDir>/node_modules'],
  // The libraries' relative imports carry the nodenext `.js` suffix (see jest.resolver.js).
  resolver: '<rootDir>/jest.resolver.js',
  setupFiles: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@tanstack/.*)',
  ],
  modulePathIgnorePatterns: ['<rootDir>/ios/', '<rootDir>/android/'],
  clearMocks: true,
};
