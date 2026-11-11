// ELK in a Web Worker, without an import of elkjs in the app: elkjs's declarations do not type-check with
// skipLibCheck off (see elk-types.ts), and this module's declaration names only this package's types. The package
// is built without the DOM's types (it runs in Node too), so the browser's Worker is taken from globalThis.

import ELK from 'elkjs/lib/elk-api.js'
import type { ElkLike } from './types'

type WorkerConstructor = new (url: string) => unknown

/**
 * An ELK instance that lays out in a Web Worker: elkjs's `elk-api`, talking to elkjs's `elk-worker.min.js` at
 * `workerUrl` (a string or a URL; serve that file with the app: with Vite,
 * `import workerUrl from 'elkjs/lib/elk-worker.min.js?url'`). Pass it to `layoutChart` as `elk`. Needs Web Workers (a
 * browser); elsewhere leave `elk` out and `layoutChart` runs elkjs on the calling thread.
 */
export function workerElk(workerUrl: string | { readonly href: string }): ElkLike {
    const Worker = (globalThis as unknown as { Worker?: WorkerConstructor }).Worker
    if (!Worker) throw new Error('workerElk needs Web Workers (a browser); elsewhere leave out `elk`, and layoutChart runs elkjs on this thread')
    const url = typeof workerUrl === 'string' ? workerUrl : workerUrl.href
    return new ELK({ workerFactory: () => new Worker(url) } as unknown as ConstructorParameters<typeof ELK>[0]) as unknown as ElkLike
}
