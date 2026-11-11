import { configDefaults, defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// The engine's and the diagram's timing targets run alone, after everything else: inside the parallel suite (one worker per core)
// their numbers measure the machine's load, not the engine.
const PERF = ['tests/engine/performance.test.ts', 'tests/diagram/speed.test.ts']

export default defineConfig({
    resolve: {
        alias: {
            '~engine': fileURLToPath(new URL('./packages/engine/src', import.meta.url)),
            '~diagram': fileURLToPath(new URL('./packages/diagram/src', import.meta.url)),
            '~examples': fileURLToPath(new URL('./src/examples', import.meta.url)),
        },
    },
    test: {
        testTimeout: 30000,
        projects: [
            {
                extends: true,
                test: {
                    name: 'site',
                    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
                    exclude: [...configDefaults.exclude, ...PERF],
                },
            },
            { extends: true, test: { name: 'perf', include: PERF, sequence: { groupOrder: 1 } } },
        ],
    },
})
