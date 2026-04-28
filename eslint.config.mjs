// Aramo Core ESLint flat config (Nx 22 default format).
//
// Two-tier vocabulary enforcement (per ADR-0001 decision; precedent set in PR-1):
//   - This file: ESLint `no-restricted-syntax` flags identifiers and string
//     literals containing the locked-vocabulary anti-terms listed in
//     doc/02-claude-code-discipline.md Rule 5 (excluding `linkedin`).
//   - scripts/verify-vocabulary.sh: ripgrep gate that enforces the strict
//     R7 LinkedIn refusal across the entire repo with a sealed allowlist.
//
// `linkedin` deliberately does not appear in this file; it lives only in
// scripts/verify-vocabulary.sh and doc/03-refusal-layer.md (per R7).

import nx from '@nx/eslint-plugin';
import importX from 'eslint-plugin-import-x';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.nx/**',
      '**/prisma/generated/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
  // PR-1 precedent: eslint-plugin-import-x substituted for eslint-plugin-import
  // due to the latter's peer range stopping at ESLint 9. Two rules enabled:
  // import-x/order (style consistency) and import-x/no-cycle (DAG discipline
  // across the 13-module monorepo). ADR-0001 (PR-1.1) will document this
  // substitution in Decision section 2 (tooling pins).
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: { 'import-x': importX },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
        },
      ],
      'import-x/no-cycle': [
        'error',
        { maxDepth: Infinity },
      ],
    },
  },
  {
    // Vocabulary discipline (per doc/02-claude-code-discipline.md Rule 5).
    // Scoped to product source only — eslint config, scripts, and docs are
    // not subject to identifier/literal scanning here.
    files: ['apps/**/*.{ts,tsx,js,jsx}', 'libs/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name=/candidate/i]",
          message: "Use 'talent' (not 'candidate') — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/candidate/i]",
          message: "Use 'talent' (not 'candidate') in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/customer/i]",
          message: "Use 'tenant' (not 'customer') — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/customer/i]",
          message: "Use 'tenant' (not 'customer') in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/outreach/i]",
          message: "Use 'engagement' (not 'outreach' as entity name) — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/outreach/i]",
          message: "Use 'engagement' (not 'outreach' as entity name) in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/evaluation/i]",
          message: "Use 'examination' (not 'evaluation' as entity name) — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/evaluation/i]",
          message: "Use 'examination' (not 'evaluation' as entity name) in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/submission/i]",
          message: "Use 'submittal' (not 'submission' as entity name) — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/submission/i]",
          message: "Use 'submittal' (not 'submission' as entity name) in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
      ],
    },
  },
];
