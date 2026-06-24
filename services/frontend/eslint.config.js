import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config (ESLint 9). Stage 0 baseline: recommended JS + TS rules.
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
