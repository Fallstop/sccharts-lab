// Module resolution for running the engine's TypeScript sources directly with Node (--experimental-transform-types):
// the engine imports without extensions ('./parser/ids'), as Vite allows; this adds `.ts` / `/index.ts`.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith('file:')) {
        for (const ext of ['.ts', '/index.ts']) {
            const url = new URL(specifier + ext, context.parentURL)
            if (existsSync(fileURLToPath(url))) return next(url.href, context)
        }
    }
    return next(specifier, context)
}
