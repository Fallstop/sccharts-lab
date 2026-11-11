// The postMessage protocol between a page and an embedded SCCharts Lab chart (/embed/ in an iframe). Every message,
// both ways, is a plain object in one envelope: `{ type: 'sccharts-lab', version: 1, ... }`. The page sends commands
// (`command`), the embed answers with events (`event`). A command may carry an `id`; the embed then answers it with a
// `reply` event of the same id. Anything that is not such an object is ignored; nothing is ever evaluated.
//
// Pure and dependency-free: the custom element (element.ts) and the site's embed page (src/components/embed) both
// use it.

export const PROTOCOL = 'sccharts-lab'
export const VERSION = 1

/** A value of the chart's data pool (KIELER's names: a valued signal `V` is `V`, its presence, and `V_val`). */
export type Value = boolean | number | string | null | Value[]
export type Inputs = Record<string, Value>

// ----- Commands (page to embed) -----------------------------------------------------------------------------------

export type EmbedCommand =
    /** Replaces the text of the file shown (one file: the chart). The simulation starts again on it. */
    | { command: 'setSource'; source: string }
    /** Opens a project of several files (`active`: the one shown and simulated, else the first). */
    | { command: 'setFiles'; files: Record<string, string>; active?: string; name?: string }
    /** Shows and simulates another chart of the file (a file with several `scchart`s). */
    | { command: 'selectChart'; chart: string }
    /** Sets these inputs (they keep their values afterwards, as in KIELER) and runs one tick. */
    | { command: 'step'; inputs?: Inputs }
    /** Sets these inputs for the next tick without running it. */
    | { command: 'setInputs'; inputs: Inputs }
    /** Back to tick 0 (the ticks computed are dropped). */
    | { command: 'reset' }
    /** Shows tick `tick` of the ticks computed (0: before the first); the later ones stay and Step replays them. */
    | { command: 'rewind'; tick: number }
    /** Answers with the chart's compile and the tick shown (a `reply` with `result: { compiled, tick }`). */
    | { command: 'getState' }

export type CommandName = EmbedCommand['command']
export const COMMANDS: readonly CommandName[] = ['setSource', 'setFiles', 'selectChart', 'step', 'setInputs', 'reset', 'rewind', 'getState']

export type CommandId = string | number
export type CommandMessage = EmbedCommand & { type: typeof PROTOCOL; version: typeof VERSION; id?: CommandId }

// ----- Events (embed to page) -------------------------------------------------------------------------------------

export interface DiagnosticInfo {
    severity: 'error' | 'warning' | 'info'
    message: string
    code?: string
    hint?: string
    /** 1-based, where the source has a place for it. */
    line?: number
    column?: number
    endLine?: number
    endColumn?: number
}

export interface VariableInfo {
    name: string
    /** `pure` (a signal without a value), `bool`, `int`, `float`, `string`, ... */
    type: string
    signal: boolean
    valued: boolean
    /** Array dimensions (empty for scalars). */
    dims: number[]
}

export interface CompiledInfo {
    /** KIELER would accept the chart (no errors). */
    ok: boolean
    /** The file compiled. */
    file: string
    /** The chart shown and simulated. */
    chart?: string
    /** Every chart of the file. */
    charts: string[]
    diagnostics: DiagnosticInfo[]
    inputs: VariableInfo[]
    outputs: VariableInfo[]
}

export interface TickInfo {
    /** The tick shown: 0 before the first. */
    tick: number
    /** Ticks computed (after `rewind`, more than `tick`). */
    ticks: number
    /** The guided tour (or a shared run) is in control. */
    tour: boolean
    /** KIELER's data pool after the tick: inputs, outputs and the chart's variables. Empty at tick 0. */
    values: Record<string, Value>
    /** Signal presence in the tick. */
    present: Record<string, boolean>
    /** Ids of the states active at the end of the tick (`ABRO.ABO.WaitAB.WaitA`, with their ancestors). */
    active: string[]
    /** States entered, transitions taken (`ABRO.ABO.WaitAB.WaitB->1`, in firing order). */
    entered: string[]
    taken: string[]
    /** What the chart printed in the tick (`print(...)`). */
    printed: string[]
    terminated: boolean
    /** A run-time error stopped the simulation in this tick. */
    error?: string
}

export interface ReadyInfo {
    view: string
    compiled?: CompiledInfo
    tick: TickInfo
}

export type EmbedEvent =
    | ({ event: 'ready' } & ReadyInfo)
    | ({ event: 'compiled' } & CompiledInfo)
    | ({ event: 'tick' } & TickInfo)
    | { event: 'resize'; height: number }
    | { event: 'error'; message: string; command?: string }
    | { event: 'reply'; id: CommandId; ok: boolean; error?: string; result?: unknown }

export type EventName = EmbedEvent['event']
export type EventMessage = EmbedEvent & { type: typeof PROTOCOL; version: typeof VERSION }

/** Wraps an event (or a command) in the envelope. */
export function envelope<T extends object>(body: T): T & { type: typeof PROTOCOL; version: typeof VERSION } {
    return { type: PROTOCOL, version: VERSION, ...body }
}

// ----- Validation ---------------------------------------------------------------------------------------------------

/** Limits that keep a message from a page cheap to check and to run. */
export const LIMITS = { source: 1_000_000, files: 200, path: 200, inputs: 500, array: 10_000, depth: 4, id: 200 }

export type Parsed =
    | { kind: 'command'; message: CommandMessage }
    /** In the envelope, but not a command this embed can run: answer with an error. */
    | { kind: 'invalid'; error: string; id?: CommandId; command?: string }
    /** Not for us (another protocol, an event, not an object): ignore it. */
    | { kind: 'ignore' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const NAME = /^[A-Za-z_]\w{0,199}$/

/** A value a chart can take (finite numbers, nested arrays up to LIMITS.depth). */
export function isValue(v: unknown, depth = 0): v is Value {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (Array.isArray(v)) return depth < LIMITS.depth && v.length <= LIMITS.array && v.every(x => isValue(x, depth + 1))
    return false
}

/** Inputs by name: an object of identifiers to values; the reason it is not, else undefined. */
export function checkInputs(v: unknown): string | undefined {
    if (!isObject(v)) return '`inputs` must be an object of input names to values.'
    const keys = Object.keys(v)
    if (keys.length > LIMITS.inputs) return `At most ${LIMITS.inputs} inputs at once.`
    for (const k of keys) {
        if (!NAME.test(k) || FORBIDDEN.has(k)) return `\`${k.slice(0, 40)}\` is not an input name.`
        if (!isValue(v[k])) return `The value of \`${k}\` is not a boolean, a number, a string, null or an array of them.`
    }
    return undefined
}

/** A project file's path: relative, `.sctx`, no `..`. */
export function checkPath(p: unknown): string | undefined {
    if (typeof p !== 'string' || !p || p.length > LIMITS.path) return 'A file name must be a short string.'
    if (!/^[\w ./+-]+\.sctx$/i.test(p) || p.startsWith('/') || p.split('/').some(s => s === '..' || s === '.' || s === '')) return `\`${p.slice(0, 60)}\` is not a file name like \`main.sctx\` or \`lib/beep.sctx\`.`
    return undefined
}

const copyInputs = (v: Record<string, unknown>): Inputs => Object.fromEntries(Object.keys(v).map(k => [k, v[k] as Value]))

/**
 * Reads a message sent to the embed. Only objects in the envelope with a `command` are commands; everything else is
 * ignored. A command in the envelope that cannot run (another version, an unknown command, a wrong argument) is
 * `invalid`, with the reason. The command returned is a fresh copy holding only the fields it uses.
 */
export function parseCommand(data: unknown): Parsed {
    if (!isObject(data) || data.type !== PROTOCOL || typeof data.command !== 'string') return { kind: 'ignore' }
    const rawId = data.id
    const id = (typeof rawId === 'string' && rawId.length <= LIMITS.id) || (typeof rawId === 'number' && Number.isFinite(rawId)) ? rawId : undefined
    const command = data.command.slice(0, 40)
    const bad = (error: string): Parsed => ({ kind: 'invalid', error, id, command })
    if (data.version !== VERSION) return bad(`This embed speaks version ${VERSION} of the protocol, not ${String(data.version).slice(0, 20)}.`)
    const base = { type: PROTOCOL, version: VERSION, ...(id !== undefined ? { id } : {}) } as const
    switch (data.command) {
        case 'setSource': {
            if (typeof data.source !== 'string') return bad('`source` must be a string.')
            if (data.source.length > LIMITS.source) return bad('The source is too long.')
            return { kind: 'command', message: { ...base, command: 'setSource', source: data.source } }
        }
        case 'setFiles': {
            if (!isObject(data.files)) return bad('`files` must be an object of file names to texts.')
            const paths = Object.keys(data.files)
            if (!paths.length) return bad('`files` has no file.')
            if (paths.length > LIMITS.files) return bad(`At most ${LIMITS.files} files.`)
            let size = 0
            const files: Record<string, string> = {}
            for (const p of paths) {
                const why = checkPath(p)
                if (why) return bad(why)
                const text = data.files[p]
                if (typeof text !== 'string') return bad(`The text of \`${p}\` must be a string.`)
                size += text.length
                files[p] = text
            }
            if (size > LIMITS.source) return bad('The files are too long.')
            if (own(data, 'active') && data.active !== undefined && (typeof data.active !== 'string' || !own(files, data.active))) return bad('`active` must name one of the files.')
            if (own(data, 'name') && data.name !== undefined && (typeof data.name !== 'string' || data.name.length > LIMITS.path)) return bad('`name` must be a short string.')
            return {
                kind: 'command',
                message: { ...base, command: 'setFiles', files, ...(typeof data.active === 'string' ? { active: data.active } : {}), ...(typeof data.name === 'string' && data.name.trim() ? { name: data.name.trim() } : {}) },
            }
        }
        case 'selectChart': {
            if (typeof data.chart !== 'string' || !NAME.test(data.chart)) return bad('`chart` must be the name of a chart.')
            return { kind: 'command', message: { ...base, command: 'selectChart', chart: data.chart } }
        }
        case 'step': {
            if (data.inputs === undefined) return { kind: 'command', message: { ...base, command: 'step' } }
            const why = checkInputs(data.inputs)
            if (why) return bad(why)
            return { kind: 'command', message: { ...base, command: 'step', inputs: copyInputs(data.inputs as Record<string, unknown>) } }
        }
        case 'setInputs': {
            const why = checkInputs(data.inputs)
            if (why) return bad(why)
            return { kind: 'command', message: { ...base, command: 'setInputs', inputs: copyInputs(data.inputs as Record<string, unknown>) } }
        }
        case 'reset':
            return { kind: 'command', message: { ...base, command: 'reset' } }
        case 'rewind': {
            const t = data.tick
            if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) return bad('`tick` must be a whole number, 0 or more.')
            return { kind: 'command', message: { ...base, command: 'rewind', tick: t } }
        }
        case 'getState':
            return { kind: 'command', message: { ...base, command: 'getState' } }
        default:
            return bad(`There is no command \`${command}\`. The commands are ${COMMANDS.join(', ')}.`)
    }
}

/** Reads a message sent by the embed: an event in the envelope, else undefined. */
export function parseEvent(data: unknown): EventMessage | undefined {
    if (!isObject(data) || data.type !== PROTOCOL || data.version !== VERSION || typeof data.event !== 'string') return undefined
    return data as unknown as EventMessage
}
