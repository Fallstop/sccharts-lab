import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    resolve: {
        alias: {
            '~engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
            '~diagram': fileURLToPath(new URL('./src/diagram', import.meta.url)),
            '~examples': fileURLToPath(new URL('./src/examples', import.meta.url)),
        },
    },
    test: {
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        testTimeout: 30000,
    },
})
