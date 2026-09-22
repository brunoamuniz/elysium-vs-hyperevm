import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.venv/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    files: ['public/**/*.js', 'web/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.browser },
  },
];
