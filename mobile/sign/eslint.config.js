// ESLint flat config for the Aramo Sign mobile app (separate from the web monorepo's
// eslint.config.mjs; this package is outside the npm workspaces, directive §2).
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'ios/**',
      'android/**',
      'node_modules/**',
      'coverage/**',
      '.expo/**',
      'src/api/generated/**',
    ],
  },
  {
    rules: {
      // Capability tokens and credentials must never reach logs (directive §9, M-A2 §3.4).
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // App code runs on Hermes: no Node built-ins (tests and scripts may use them).
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/__tests__/**', 'src/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['node:*'], message: 'Node built-ins are not available on device.' }],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Use src/util/bytes.ts (Buffer is not available on device).' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
]);
