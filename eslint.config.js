import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { fileURLToPath } from 'node:url';

const boundary = (patterns) => [
  'error',
  {
    patterns: [
      {
        group: patterns,
        message:
          'Keep application code in its own package; share contracts through @stageflow/shared.',
      },
    ],
  },
];

export default defineConfig([
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  {
    files: ['*.js', 'scripts/**/*.mjs', 'deploy/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['apps/api/*.ts', 'packages/shared/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/**/src/**/*.{ts,tsx}', 'packages/shared/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/__tests__/**'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-imports': boundary([
        '**/apps/api/**',
        '**/api/**',
        '@stageflow/api',
        '@stageflow/api/**',
      ]),
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-imports': boundary([
        '**/apps/web/**',
        '**/web/**',
        '@stageflow/web',
        '@stageflow/web/**',
      ]),
    },
  },
  {
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/)',
              message: 'Shared source must stay runtime-independent; use relative shared modules.',
            },
            {
              group: ['**/apps/**', '**/api/**', '**/web/**'],
              message: 'Shared source cannot import application code.',
            },
          ],
        },
      ],
    },
  },
]);
