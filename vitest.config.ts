import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/server/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/web/**/*.test.tsx'],
          setupFiles: ['src/web/test-setup.ts'],
        },
      },
    ],
    passWithNoTests: true,
  },
})
