import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test/fixtures/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/inject/**'], languageOptions: { globals: globals.browser } },
  { files: ['src/**', 'test/**', 'scripts/**', '*.ts', '*.js'], ignores: ['src/inject/**'], languageOptions: { globals: globals.node } },
);
