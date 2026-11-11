import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    resolve: {
        alias: {
            '~engine': fileURLToPath(new URL('./packages/engine/src', import.meta.url)),
            '~diagram': fileURLToPath(new URL('./packages/diagram/src', import.meta.url)),
            '~examples': fileURLToPath(new URL('./src/examples', import.meta.url)),
        },
    },
    test: {
        include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
        testTimeout: 30000,
    },
})
