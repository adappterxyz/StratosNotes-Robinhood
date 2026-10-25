// ESLint flat config for the TypeScript workspaces (app, landing, packages, services, scripts, cre, web).
// Solidity (packages/evm-engine) and generated files are out of scope.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      'packages/evm-engine/**',
      'packages/sdk/src/evm/generated.ts',
      'cre/notes-keeper-evm/.cre_build_tmp.js',
      'deployments/**',
      'docs/**',
      'ops/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: {
      // The existing `eslint-disable-line react-hooks/exhaustive-deps` comments record deliberate dependency
      // choices (load-once effects, memo keys); keep them even where the rule currently has nothing to report.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // `_`-prefixed names are the codebase's convention for intentionally unused bindings, e.g. omitting a key
      // with `const { [key]: _, ...rest } = obj`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // React hooks rules for the two React apps.
    files: ['app/src/**/*.{ts,tsx}', 'landing/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
