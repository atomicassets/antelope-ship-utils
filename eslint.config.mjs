// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
    // Ignore patterns
    {
        ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts'],
    },

    // Base ESLint recommended rules
    eslint.configs.recommended,

    // TypeScript ESLint recommended rules
    ...tseslint.configs.recommended,

    // Prettier compatibility (disables conflicting rules)
    eslintConfigPrettier,

    // Global configuration for all TypeScript files
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2022,
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'off', // Don't warn about stale disable comments
        },
        rules: {
            // TypeScript Rules
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-inferrable-types': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrors: 'none', // Allow unused catch clause parameters
                },
            ],
            '@typescript-eslint/no-duplicate-enum-values': 'off', // Allow duplicate enum values (intentional in this codebase)
            '@typescript-eslint/explicit-function-return-type': 'error',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',

            // General Rules
            'no-async-promise-executor': 'off',
            quotes: ['error', 'single', { avoidEscape: true }],
            semi: ['error', 'always'],
            'no-console': 'error',

            // Best Practices
            'no-debugger': 'error',
            'no-alert': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },

    // JavaScript files (config files, etc.)
    {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },

    // Test files - more relaxed rules
    {
        files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts', '**/__tests__/**/*.ts', '**/test-helper/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-unused-expressions': 'off', // Allow Chai assertions
            'no-console': 'off',
        },
    },
);
