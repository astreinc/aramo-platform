// Client Rule Consolidation C2-3 / C2-5 — the libs/sign-client specs run here too (the SAME
// files vitest runs on the web side), so a rule change is tested on both runtimes.
const signClientSrc = '<rootDir>/../../libs/sign-client/src';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', signClientSrc],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)', `${signClientSrc}/__tests__/**/*.test.ts`],
  moduleNameMapper: {
    '^@aramo/sign-client$': `${signClientSrc}/index.ts`,
  },
  // The library's relative imports carry the nodenext `.js` suffix (see jest.resolver.js).
  resolver: '<rootDir>/jest.resolver.js',
  setupFiles: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@tanstack/.*)',
  ],
  modulePathIgnorePatterns: ['<rootDir>/ios/', '<rootDir>/android/'],
  clearMocks: true,
};
