import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .tmp-*: scratch directories (tests, local probes), gitignored and not ours to lint
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.tmp-*/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
