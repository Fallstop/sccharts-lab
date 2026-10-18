/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { isTimeDelta } from './helper'

// Simulation traces as files: what Save writes, and what Replay and Compare read.
// The tests load this file without VS Code, so it must stay free of vscode imports.

export type TraceRole = 'input' | 'output' | 'local'

export interface TraceVariable {
    name: string
    /** Unknown when the file does not record it, as in CSV. */
    role?: TraceRole
    /** The model's type name (bool, int, float, string), when known. */
    type?: string
}

/** A run of a model: every variable's value after each tick. */
export interface TraceRecord {
    /** File name of the simulated model, when known. */
    model?: string
    variables: TraceVariable[]
    /** `ticks[i]` holds the values after tick i + 1. A value the file never gave is undefined. */
    ticks: Record<string, unknown>[]
    /** Ticks (1-based) after which a replay stops running, from KTrace `pause`. */
    pauses?: number[]
    /** Things the reader dropped or guessed, worth telling the user. */
    notes?: string[]
    /**
     * Seconds at each tick, for a run on a timed sequence. In a sequence, the moments its rows
     * happen: such a sequence describes input changes in time rather than per tick.
     */
    times?: number[]
}

export type TraceFormat = 'ktrace' | 'csv' | 'json' | 'xml'

export const TRACE_FORMATS: { format: TraceFormat; label: string; extension: string }[] = [
    { format: 'ktrace', label: 'KTrace', extension: 'ktrace' },
    { format: 'csv', label: 'CSV', extension: 'csv' },
    { format: 'json', label: 'JSON', extension: 'json' },
    { format: 'xml', label: 'XML', extension: 'xml' },
]

/** Identifies this lab's JSON and XML traces. */
export const TRACE_FORMAT_ID = 'sccharts-lab-trace'

export class TraceFileError extends Error {
    constructor(message: string, line?: number) {
        super(line === undefined ? message : `Line ${line}: ${message}`)
        this.name = 'TraceFileError'
    }
}

export function traceFormatOf(fileName: string): TraceFormat | undefined {
    const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    return TRACE_FORMATS.find((entry) => entry.extension === extension)?.format
}

/** Values are the same when they are equal, or are primitives that print the same (CSV reads `"7"` as 7). */
export function sameTraceValue(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((entry, index) => sameTraceValue(entry, b[index]))
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = Object.keys(a)
        return (
            keys.length === Object.keys(b).length &&
            keys.every((key) =>
                sameTraceValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
            )
        )
    }
    const primitive = (value: unknown) => ['boolean', 'number', 'string'].includes(typeof value)
    return primitive(a) && primitive(b) && String(a) === String(b)
}

/** Text for a value in a report or a CSV cell: arrays and structs as JSON, strings as they are. */
export function formatTraceValue(value: unknown): string {
    if (value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
}

/** The variable that tells timed models how much time passed in a tick, if the trace has one. */
export function timeDeltaOf(trace: TraceRecord): TraceVariable | undefined {
    return trace.variables.find(
        (variable) =>
            variable.role !== 'output' &&
            variable.role !== 'local' &&
            isTimeDelta({ id: variable.name, categories: [] })
    )
}

/**
 * Seconds after each tick: the times a timed run recorded, else the running sum of the time
 * delta; undefined without either.
 */
export function traceTimes(trace: TraceRecord): number[] | undefined {
    if (trace.times) return trace.times
    const delta = timeDeltaOf(trace)
    if (!delta) return undefined
    let time = 0
    return trace.ticks.map((tick) => {
        const value = Number(tick[delta.name])
        if (Number.isFinite(value)) time += value
        // Float sums drift (0.1 + 0.2); a trace's times are only ever read to the microsecond.
        return Math.round(time * 1e9) / 1e9
    })
}

/** The record with only the inputs, as replayed into another model. */
export function inputsOnly(trace: TraceRecord): TraceRecord {
    const variables = trace.variables.filter((variable) => variable.role === 'input')
    return {
        ...trace,
        variables,
        ticks: trace.ticks.map((tick) => Object.fromEntries(variables.map(({ name }) => [name, tick[name]]))),
    }
}

/** Fills in the values a sparse file left out with the tick before's. */
function carryForward(ticks: Record<string, unknown>[], variables: TraceVariable[]): Record<string, unknown>[] {
    const last: Record<string, unknown> = {}
    return ticks.map((tick) => {
        const full: Record<string, unknown> = {}
        variables.forEach(({ name }) => {
            if (tick[name] !== undefined) last[name] = tick[name]
            full[name] = last[name]
        })
        return full
    })
}

/** Times given per tick count only without a time delta, which they would merely repeat. */
function givenTimes(
    times: (number | undefined)[],
    variables: TraceVariable[],
    where: (index: number) => string
): number[] | undefined {
    const hasDelta = variables.some((variable) => isTimeDelta({ id: variable.name, categories: [] }))
    if (hasDelta || times.every((time) => time === undefined)) return undefined
    return times.map((time, index) => {
        if (time === undefined || !Number.isFinite(time)) throw new TraceFileError(`${where(index)} has no time.`)
        return time
    })
}

function typeOfValue(value: unknown): string | undefined {
    if (Array.isArray(value)) return value.length > 0 ? typeOfValue(value[0]) : undefined
    if (typeof value === 'boolean') return 'bool'
    if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
    if (typeof value === 'string') return 'string'
    return undefined
}

/** Adds the variables a reader met, in order of first appearance. */
class VariableList {
    readonly variables: TraceVariable[] = []

    private readonly byName = new Map<string, TraceVariable>()

    add(name: string, role?: TraceRole, type?: string): TraceVariable {
        let variable = this.byName.get(name)
        if (!variable) {
            variable = { name, role, type }
            this.byName.set(name, variable)
            this.variables.push(variable)
        } else {
            variable.role = variable.role ?? role
            // A float literal anywhere makes the variable a float, even when it began as 0.
            variable.type = variable.type === 'int' && type === 'float' ? type : variable.type ?? type
        }
        return variable
    }

    get(name: string): TraceVariable | undefined {
        return this.byName.get(name)
    }
}

/**
 * Text in a CSV cell or an XML element as a value. Arrays and structs are JSON; for strings the
 * type decides, since a string input may well hold "12" or "true".
 */
function decodeText(text: string, type?: string): unknown {
    const trimmed = text.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            return JSON.parse(trimmed)
        } catch {
            // Not JSON after all: an ordinary string.
        }
    }
    if (type === 'string') return text
    if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true'
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed)
    if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16)
    return text
}

// -- KTrace ----------------------------------------------------------------------------------------

const KTRACE_KEYWORDS = ['reset', 'pause', 'goto']

function ktraceName(name: string): string {
    return KTRACE_KEYWORDS.includes(name) ? `^${name}` : name
}

function ktraceValue(value: unknown, type: string | undefined, name: string): string {
    if (typeof value === 'boolean') return String(value)
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TraceFileError(`${name} is ${value}, which KTrace cannot hold.`)
        const float = type === 'float' || type === 'double' || !Number.isInteger(value)
        // A float written without a point reads back as an int, and KIELER's trace check then fails it.
        return float && Number.isInteger(value) ? value.toFixed(1) : String(value)
    }
    if (typeof value === 'string') return JSON.stringify(value)
    if (Array.isArray(value)) return `{${value.map((entry) => ktraceValue(entry, type, name)).join(', ')}}`
    throw new TraceFileError(`${name} holds a struct, which KTrace cannot hold. Save as JSON or XML instead.`)
}

/**
 * KTrace as KIELER writes it: one tick per line, inputs then `=>` and outputs, each value only
 * when it changed. Variables that are neither inputs nor outputs have no place in KTrace.
 */
function writeKTrace(trace: TraceRecord): string {
    const inputs = trace.variables.filter((variable) => variable.role === 'input')
    const outputs = trace.variables.filter((variable) => variable.role === 'output')
    const lines = [`// ${trace.model ?? 'Simulation'}: ${trace.ticks.length} ticks, saved by SCCharts Lab`]
    const last = new Map<string, unknown>()
    const changes = (variables: TraceVariable[], tick: Record<string, unknown>) =>
        variables.flatMap(({ name, type }) => {
            const value = tick[name]
            if (value === undefined || value === null) return []
            if (last.has(name) && sameTraceValue(last.get(name), value)) return []
            last.set(name, value)
            return [`${ktraceName(name)} = ${ktraceValue(value, type, name)}`]
        })
    trace.ticks.forEach((tick, index) => {
        const ins = changes(inputs, tick)
        const outs = changes(outputs, tick)
        let line = ins.join(' ')
        if (outs.length > 0) line += `${line ? ' ' : ''}=> ${outs.join(' ')}`
        if (trace.pauses?.includes(index + 1)) line += `${line ? ' ' : ''}pause`
        lines.push(`${line};`)
    })
    return `${lines.join('\n')}\n`
}

type Token = { kind: 'name' | 'number' | 'string' | 'symbol'; text: string; value?: unknown; line: number }

function tokenizeKTrace(text: string): Token[] {
    const tokens: Token[] = []
    let line = 1
    let i = 0
    while (i < text.length) {
        const ch = text[i]
        if (ch === '\n') {
            line++
            i++
        } else if (/\s/.test(ch)) {
            i++
        } else if (text.startsWith('//', i)) {
            while (i < text.length && text[i] !== '\n') i++
        } else if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2)
            if (end < 0) throw new TraceFileError('A comment is not closed with */.', line)
            line += (text.slice(i, end).match(/\n/g) ?? []).length
            i = end + 2
        } else if (ch === '#') {
            // Pragmas such as #include apply to KIELER's test runner, not to replaying.
            while (i < text.length && text[i] !== '\n') i++
        } else if (ch === '"') {
            let j = i + 1
            while (j < text.length && text[j] !== '"') {
                if (text[j] === '\n') throw new TraceFileError('A string is not closed on its line.', line)
                j += text[j] === '\\' ? 2 : 1
            }
            if (j >= text.length) throw new TraceFileError('A string is not closed.', line)
            const literal = text.slice(i, j + 1)
            let value: string
            try {
                value = JSON.parse(literal)
            } catch {
                // KIELER also accepts escapes JSON does not, such as \'.
                value = literal.slice(1, -1).replace(/\\(.)/g, '$1')
            }
            tokens.push({ kind: 'string', text: literal, value, line })
            i = j + 1
        } else if (text.startsWith('=>', i)) {
            tokens.push({ kind: 'symbol', text: '=>', line })
            i += 2
        } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
            const match = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fF]?)/.exec(text.slice(i))
            const literal = match?.[0] ?? ch
            const hex = /^0[xX]/.test(literal)
            const float = !hex && /[.eEfF]/.test(literal)
            const value = hex ? Number.parseInt(literal, 16) : Number(literal.replace(/[fF]$/, ''))
            tokens.push({ kind: 'number', text: float ? 'float' : 'int', value, line })
            i += literal.length
        } else if (/[\^A-Za-z_]/.test(ch)) {
            const match = /^\^?[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))
            if (!match) throw new TraceFileError(`Unexpected "${ch}".`, line)
            tokens.push({ kind: 'name', text: match[0], line })
            i += match[0].length
        } else if ('=;{},:-[]'.includes(ch)) {
            tokens.push({ kind: 'symbol', text: ch, line })
            i++
        } else {
            throw new TraceFileError(`Unexpected "${ch}".`, line)
        }
    }
    return tokens
}

/**
 * Reads the literal part of KTrace: ticks of `name = value` assignments, `=>` before the outputs,
 * `pause`, and `reset;` between traces (only the first is kept). Values must be literals.
 */
function readKTrace(text: string): TraceRecord {
    const tokens = tokenizeKTrace(text)
    const list = new VariableList()
    const ticks: Record<string, unknown>[] = []
    const pauses: number[] = []
    const notes: string[] = []
    let pos = 0
    const peek = (offset = 0) => tokens[pos + offset]
    const isSymbol = (token: Token | undefined, symbol: string) => token?.kind === 'symbol' && token.text === symbol
    const isWord = (token: Token | undefined, word: string) => token?.kind === 'name' && token.text === word
    const lastLine = () => tokens[tokens.length - 1]?.line
    const expect = (symbol: string) => {
        const token = tokens[pos]
        if (!isSymbol(token, symbol)) {
            throw new TraceFileError(
                `Expected "${symbol}"${token ? ` before "${token.text}"` : ' at the end'}.`,
                token?.line ?? lastLine()
            )
        }
        pos++
    }

    const value = (): { value: unknown; type?: string } => {
        const token = tokens[pos]
        if (!token) throw new TraceFileError('A value is missing at the end of the file.', lastLine())
        if (isSymbol(token, '-')) {
            pos++
            const number = tokens[pos]
            if (number?.kind !== 'number') throw new TraceFileError('Expected a number after "-".', token.line)
            pos++
            return { value: -(number.value as number), type: number.text }
        }
        if (isSymbol(token, '{')) {
            pos++
            const entries: unknown[] = []
            let type: string | undefined
            while (!isSymbol(peek(), '}')) {
                const entry = value()
                entries.push(entry.value)
                type = type ?? entry.type
                if (!isSymbol(peek(), '}')) expect(',')
            }
            pos++
            return { value: entries, type }
        }
        pos++
        if (token.kind === 'number') return { value: token.value, type: token.text }
        if (token.kind === 'string') return { value: token.value, type: 'string' }
        if (isWord(token, 'true') || isWord(token, 'false')) return { value: token.text === 'true', type: 'bool' }
        throw new TraceFileError(
            `Only literal values can be replayed, such as true, 3, 1.5, "text" or {1, 2}; found "${token.text}".`,
            token.line
        )
    }

    while (pos < tokens.length) {
        // `reset;` separates traces; one may also open or close the file.
        if (isWord(peek(), 'reset') && isSymbol(peek(1), ';')) {
            pos += 2
            if (ticks.length > 0) {
                const more = tokens.slice(pos).filter((token) => isSymbol(token, ';')).length
                if (more > 0) notes.push('The file holds more than one trace; only the first is used.')
                break
            }
        } else {
            if (peek()?.kind === 'name' && isSymbol(peek(1), ':')) pos += 2 // a named tick
            const tick: Record<string, unknown> = {}
            let role: TraceRole = 'input'
            while (pos < tokens.length && !isSymbol(peek(), ';')) {
                const token = peek()
                if (isSymbol(token, '=>')) {
                    if (role === 'output') throw new TraceFileError('A tick has "=>" twice.', token.line)
                    role = 'output'
                    pos++
                } else if (isWord(token, 'pause')) {
                    pauses.push(ticks.length + 1)
                    pos++
                } else if (isWord(token, 'goto')) {
                    throw new TraceFileError(
                        'Traces that loop with goto cannot be replayed. Write the ticks out instead.',
                        token.line
                    )
                } else if (token.kind === 'name') {
                    pos++
                    if (isSymbol(peek(), '[')) {
                        throw new TraceFileError(
                            `Assign the whole array, as in ${token.text} = {1, 2}; single elements cannot be replayed.`,
                            token.line
                        )
                    }
                    expect('=')
                    const name = token.text.replace(/^\^/, '')
                    const parsed = value()
                    list.add(name, role, parsed.type)
                    tick[name] = parsed.value
                } else {
                    throw new TraceFileError(`Expected a variable name, found "${token.text}".`, token.line)
                }
            }
            expect(';')
            ticks.push(tick)
        }
    }
    return {
        variables: list.variables,
        ticks: carryForward(ticks, list.variables),
        pauses: pauses.length > 0 ? pauses : undefined,
        notes: notes.length > 0 ? notes : undefined,
    }
}

// -- CSV ------------------------------------------------------------------------------------------

function csvCell(text: string): string {
    return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * One row per tick: `tick`, `time` when the trace has a time delta, then a column per variable.
 * Booleans are true/false, arrays JSON. pandas, R and spreadsheets read it as it is.
 */
function writeCsv(trace: TraceRecord): string {
    const times = traceTimes(trace)
    const names = trace.variables.map((variable) => variable.name)
    const header = ['tick', ...(times ? ['time'] : []), ...names]
    const rows = trace.ticks.map((tick, index) => [
        String(index + 1),
        ...(times ? [String(times[index])] : []),
        ...names.map((name) => formatTraceValue(tick[name])),
    ])
    // An empty string is quoted; an empty cell means the value is unknown.
    const line = (row: string[], values?: Record<string, unknown>) =>
        row.map((text, index) => (text === '' && values?.[header[index]] === '' ? '""' : csvCell(text))).join(',')
    return `${[line(header), ...rows.map((row, index) => line(row, trace.ticks[index]))].join('\n')}\n`
}

/**
 * The rows of a CSV, blank lines included; `quoted` marks the cells that were, so `""` can be
 * told from an empty cell.
 */
function parseCsvRows(text: string): { cells: string[]; quoted: boolean[]; line: number }[] {
    const rows: { cells: string[]; quoted: boolean[]; line: number }[] = []
    let cells: string[] = []
    let quotes: boolean[] = []
    let cell = ''
    let wasQuoted = false
    let quoted = false
    let line = 1
    let rowLine = 1
    let i = 0
    const endCell = () => {
        cells.push(cell)
        quotes.push(wasQuoted)
        cell = ''
        wasQuoted = false
    }
    const endRow = () => {
        endCell()
        rows.push({ cells, quoted: quotes, line: rowLine })
        cells = []
        quotes = []
    }
    while (i < text.length) {
        const ch = text[i]
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                cell += '"'
                i++
            } else if (ch === '"') {
                quoted = false
            } else {
                if (ch === '\n') line++
                cell += ch
            }
        } else if (ch === '"' && cell.trim() === '') {
            quoted = true
            wasQuoted = true
            cell = ''
        } else if (ch === ',') {
            endCell()
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++
            endRow()
            line++
            rowLine = line
        } else {
            cell += ch
        }
        i++
    }
    if (quoted) throw new TraceFileError('A quoted cell is not closed.', rowLine)
    if (cell !== '' || cells.length > 0) endRow()
    return rows
}

/**
 * Reads a CSV with a header row and one row per tick. `tick` and, next to a time delta, `time`
 * are bookkeeping and skipped. Empty cells keep the value from the row before, so a hand-written
 * input sequence only has to note the changes.
 */
function readCsv(text: string): TraceRecord {
    const isBlank = (row: { cells: string[]; quoted: boolean[] }) =>
        row.cells.length === 1 && row.cells[0].trim() === '' && !row.quoted[0]
    const all = parseCsvRows(text.replace(/^\uFEFF/, ''))
    while (all.length > 0 && isBlank(all[all.length - 1])) all.pop()
    while (all.length > 0 && isBlank(all[0])) all.shift()
    // With one column a blank line is a row that changes nothing; with more, an empty row is
    // written as commas, and a blank line is only spacing, as pandas reads it.
    const rows = all[0]?.cells.length === 1 ? all : all.filter((row) => !isBlank(row))
    if (rows.length === 0) throw new TraceFileError('The file is empty.')
    const header = rows[0].cells.map((cell) => cell.trim())
    const seen = new Set<string>()
    header.forEach((name, index) => {
        if (!name) throw new TraceFileError(`Column ${index + 1} has no name in the header row.`, rows[0].line)
        if (seen.has(name)) throw new TraceFileError(`The header names ${name} twice.`, rows[0].line)
        seen.add(name)
    })
    const hasDelta = header.some((name) => isTimeDelta({ id: name, categories: [] }))
    const timeColumn = header.findIndex((name, index) => name === 'time' && index <= 1)
    const skipped = header.map((name, index) => (index === 0 && name === 'tick') || index === timeColumn)
    const list = new VariableList()
    header.forEach((name, index) => {
        if (!skipped[index]) list.add(name)
    })
    const ticks = rows.slice(1).map(({ cells, quoted, line }) => {
        if (cells.length > header.length) {
            throw new TraceFileError(`The row has ${cells.length} cells, the header ${header.length}.`, line)
        }
        const tick: Record<string, unknown> = {}
        header.forEach((name, index) => {
            const cell = cells[index]
            if (skipped[index] || cell === undefined) return
            if (quoted[index] && cell === '') tick[name] = ''
            else if (cell.trim() !== '') tick[name] = decodeText(cell)
        })
        return tick
    })
    ticks.forEach((tick) =>
        Object.entries(tick).forEach(([name, value]) => list.add(name, undefined, typeOfValue(value)))
    )
    const times =
        timeColumn < 0 || hasDelta
            ? undefined
            : givenTimes(
                  rows.slice(1).map(({ cells }) => {
                      const cell = cells[timeColumn]?.trim()
                      return cell ? Number(cell) : undefined
                  }),
                  list.variables,
                  (index) => `Line ${rows[index + 1].line}: the row`
              )
    return { variables: list.variables, ticks: carryForward(ticks, list.variables), times }
}

// -- JSON -----------------------------------------------------------------------------------------

const GROUPS: { key: string; role?: TraceRole }[] = [
    { key: 'inputs', role: 'input' },
    { key: 'outputs', role: 'output' },
    { key: 'locals', role: 'local' },
    { key: 'values' },
]

function groupOf(role: TraceRole | undefined): string {
    return GROUPS.find((group) => group.role === role)?.key ?? 'values'
}

/** One tick per line, so a long run stays readable and diffs well. */
function writeJson(trace: TraceRecord): string {
    const times = traceTimes(trace)
    const header = {
        format: TRACE_FORMAT_ID,
        version: 1,
        ...(trace.model ? { model: trace.model } : {}),
        variables: trace.variables.map((variable) => ({
            name: variable.name,
            ...(variable.role ? { role: variable.role } : {}),
            ...(variable.type ? { type: variable.type } : {}),
        })),
    }
    const ticks = trace.ticks.map((tick, index) => {
        const entry: Record<string, unknown> = { tick: index + 1 }
        if (times) entry.time = times[index]
        trace.variables.forEach(({ name, role }) => {
            if (tick[name] === undefined) return
            const group = groupOf(role)
            entry[group] = { ...((entry[group] as Record<string, unknown>) ?? {}), [name]: tick[name] }
        })
        return `    ${JSON.stringify(entry)}`
    })
    const head = JSON.stringify(header, null, 2).replace(/\n}$/, '')
    return `${head},\n  "ticks": [\n${ticks.join(',\n')}\n  ]\n}\n`
}

/**
 * Reads this lab's JSON trace. Ticks may list only what changes, so an input sequence can be
 * written by hand: `{"ticks": [{"inputs": {"start": true}}, {}, {"inputs": {"start": false}}]}`.
 */
function readJson(text: string): TraceRecord {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        throw new TraceFileError(`The file is not valid JSON: ${error instanceof Error ? error.message : error}`)
    }
    const root = Array.isArray(parsed) ? { ticks: parsed } : (parsed as Record<string, unknown>)
    if (!root || typeof root !== 'object' || !Array.isArray(root.ticks)) {
        throw new TraceFileError('Expected an object with a "ticks" array.')
    }
    const list = new VariableList()
    if (Array.isArray(root.variables)) {
        root.variables.forEach((variable: unknown, index: number) => {
            const entry = variable as Record<string, unknown>
            if (!entry || typeof entry.name !== 'string') throw new TraceFileError(`Variable ${index + 1} has no name.`)
            const role = ['input', 'output', 'local'].includes(entry.role as string)
                ? (entry.role as TraceRole)
                : undefined
            list.add(entry.name, role, typeof entry.type === 'string' ? entry.type : undefined)
        })
    }
    const times: (number | undefined)[] = []
    const ticks = (root.ticks as unknown[]).map((tick, index) => {
        if (!tick || typeof tick !== 'object' || Array.isArray(tick)) {
            throw new TraceFileError(`Tick ${index + 1} is not an object.`)
        }
        const { time } = tick as Record<string, unknown>
        times.push(typeof time === 'number' ? time : undefined)
        const values: Record<string, unknown> = {}
        GROUPS.forEach(({ key, role }) => {
            const group = (tick as Record<string, unknown>)[key]
            if (group === undefined) return
            if (!group || typeof group !== 'object' || Array.isArray(group)) {
                throw new TraceFileError(`"${key}" of tick ${index + 1} is not an object.`)
            }
            Object.entries(group).forEach(([name, value]) => {
                list.add(name, role, typeOfValue(value))
                if (value !== null) values[name] = value
            })
        })
        return values
    })
    return {
        model: typeof root.model === 'string' ? root.model : undefined,
        variables: list.variables,
        ticks: carryForward(ticks, list.variables),
        times: givenTimes(times, list.variables, (index) => `Tick ${index + 1}`),
    }
}

// -- XML ------------------------------------------------------------------------------------------

function xmlEscape(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/[\r\n\t]/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function xmlUnescape(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
        if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
        if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)))
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity] ?? ''
    })
}

const XML_ELEMENT: Record<TraceRole, string> = { input: 'input', output: 'output', local: 'local' }

/**
 * `<trace>` with the `<variable>` declarations, then one `<tick n="1" time="…">` per tick holding
 * `<input>`, `<output>`, `<local>` (or `<value>` for an unknown role) elements.
 */
function writeXml(trace: TraceRecord): string {
    const times = traceTimes(trace)
    const attribute = (name: string, value: string | undefined) => (value ? ` ${name}="${xmlEscape(value)}"` : '')
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<trace format="${TRACE_FORMAT_ID}" version="1"${attribute('model', trace.model)}>`,
        ...trace.variables.map(
            ({ name, role, type }) =>
                `  <variable${attribute('name', name)}${attribute('role', role)}${attribute('type', type)}/>`
        ),
    ]
    trace.ticks.forEach((tick, index) => {
        lines.push(`  <tick n="${index + 1}"${times ? ` time="${times[index]}"` : ''}>`)
        trace.variables.forEach(({ name, role }) => {
            if (tick[name] === undefined) return
            const element = role ? XML_ELEMENT[role] : 'value'
            lines.push(
                `    <${element} name="${xmlEscape(name)}">${xmlEscape(formatTraceValue(tick[name]))}</${element}>`
            )
        })
        lines.push('  </tick>')
    })
    lines.push('</trace>')
    return `${lines.join('\n')}\n`
}

interface XmlElement {
    name: string
    attributes: Record<string, string>
    children: XmlElement[]
    text: string
    line: number
}

/** Enough XML for the files this lab writes and hand edits of them: elements, attributes, text, entities. */
function parseXml(text: string): XmlElement {
    const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '', line: 1 }
    const stack = [root]
    let i = 0
    const lineAt = (index: number) => (text.slice(0, index).match(/\n/g) ?? []).length + 1
    while (i < text.length) {
        const open = text.indexOf('<', i)
        const top = stack[stack.length - 1]
        if (open < 0) {
            top.text += xmlUnescape(text.slice(i))
            break
        }
        top.text += xmlUnescape(text.slice(i, open))
        if (text.startsWith('<!--', open)) {
            const end = text.indexOf('-->', open)
            if (end < 0) throw new TraceFileError('A comment is not closed with -->.', lineAt(open))
            i = end + 3
        } else if (text.startsWith('<![CDATA[', open)) {
            const end = text.indexOf(']]>', open)
            if (end < 0) throw new TraceFileError('A CDATA section is not closed.', lineAt(open))
            top.text += text.slice(open + 9, end)
            i = end + 3
        } else if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
            const end = text.indexOf('>', open)
            if (end < 0) throw new TraceFileError('A declaration is not closed.', lineAt(open))
            i = end + 1
        } else {
            const end = text.indexOf('>', open)
            if (end < 0) throw new TraceFileError('A tag is not closed with >.', lineAt(open))
            const tag = text.slice(open + 1, end)
            if (tag.startsWith('/')) {
                const name = tag.slice(1).trim()
                if (top.name !== name) {
                    throw new TraceFileError(`</${name}> closes <${top.name}>.`, lineAt(open))
                }
                stack.pop()
            } else {
                const selfClosing = tag.endsWith('/')
                const body = selfClosing ? tag.slice(0, -1) : tag
                const name = /^[^\s/]+/.exec(body)?.[0]
                if (!name) throw new TraceFileError('A tag has no name.', lineAt(open))
                const attributes: Record<string, string> = {}
                const pattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
                let match = pattern.exec(body.slice(name.length))
                while (match) {
                    attributes[match[1]] = xmlUnescape(match[3] ?? match[4] ?? '')
                    match = pattern.exec(body.slice(name.length))
                }
                const element: XmlElement = { name, attributes, children: [], text: '', line: lineAt(open) }
                top.children.push(element)
                if (!selfClosing) stack.push(element)
            }
            i = end + 1
        }
    }
    if (stack.length > 1) throw new TraceFileError(`<${stack[stack.length - 1].name}> is not closed.`)
    return root
}

function readXml(text: string): TraceRecord {
    const trace = parseXml(text).children.find((element) => element.name === 'trace')
    if (!trace) throw new TraceFileError('Expected a <trace> element.')
    const list = new VariableList()
    trace.children
        .filter((element) => element.name === 'variable')
        .forEach((element) => {
            if (!element.attributes.name) throw new TraceFileError('A <variable> has no name.', element.line)
            const { role } = element.attributes
            list.add(
                element.attributes.name,
                ['input', 'output', 'local'].includes(role) ? (role as TraceRole) : undefined,
                element.attributes.type
            )
        })
    const roles: Record<string, TraceRole | undefined> = {
        input: 'input',
        output: 'output',
        local: 'local',
        value: undefined,
    }
    const elements = trace.children.filter((element) => element.name === 'tick')
    const ticks = elements.map((element) => {
        const tick: Record<string, unknown> = {}
        element.children.forEach((child) => {
            if (!(child.name in roles)) return
            const { name } = child.attributes
            if (!name) throw new TraceFileError(`An <${child.name}> has no name.`, child.line)
            const declared = list.get(name)
            const value = decodeText(child.text, declared?.type)
            list.add(name, roles[child.name], typeOfValue(value))
            tick[name] = value
        })
        return tick
    })
    const times = elements.map(({ attributes }) => (attributes.time ? Number(attributes.time) : undefined))
    return {
        model: trace.attributes.model,
        variables: list.variables,
        ticks: carryForward(ticks, list.variables),
        times: givenTimes(times, list.variables, (index) => `The <tick> on line ${elements[index].line}`),
    }
}

// -- Entry points ---------------------------------------------------------------------------------

export function writeTrace(trace: TraceRecord, format: TraceFormat): string {
    switch (format) {
        case 'ktrace':
            return writeKTrace(trace)
        case 'csv':
            return writeCsv(trace)
        case 'json':
            return writeJson(trace)
        default:
            return writeXml(trace)
    }
}

export function readTrace(text: string, format: TraceFormat): TraceRecord {
    let trace: TraceRecord
    switch (format) {
        case 'ktrace':
            trace = readKTrace(text)
            break
        case 'csv':
            trace = readCsv(text)
            break
        case 'json':
            trace = readJson(text)
            break
        default:
            trace = readXml(text)
    }
    if (trace.ticks.length === 0) throw new TraceFileError('The trace has no ticks.')
    return trace
}
