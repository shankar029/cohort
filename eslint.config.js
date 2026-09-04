import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results', 'coverage', '**/._*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Build/asset helper + eval scripts run under Node and some use a canvas/DOM
    // shim, so allow both Node and browser globals here.
    files: ['scripts/**/*.{mjs,js}', 'evals/**/*.{mjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // These are plain JS helper scripts, not typed sources.
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
);
