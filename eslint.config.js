import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'e2e/playwright-report/**',
      'e2e/test-results/**',
      '.superpowers/**',
      'docs/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/server/**', 'src/shared/**', 'test-support/**', 'e2e/**', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/web/**'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser },
  }
)
