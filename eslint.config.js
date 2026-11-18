import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'public/vendor/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['src/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['scripts/**/*.mjs', 'tests/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
];
