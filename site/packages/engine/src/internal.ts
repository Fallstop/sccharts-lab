// Not part of the public API: what the other @sccharts-lab packages use of the engine's internals. They pin the
// engine's exact version, so this may change in any release.

export { allScopes, type CVar } from './sim/model'
export type { PoolObject } from './sim/structure/poolShape'
export { typeKey } from './sim/structure/classNames'
