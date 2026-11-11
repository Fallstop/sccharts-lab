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

import { carryForward, sameTraceValue, TraceFileError, VariableList } from './trace-record'
import type { TraceRecord, TraceRole, TraceVariable } from './trace-record'

// KTrace, KIELER's trace format.

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
export function writeKTrace(trace: TraceRecord): string {
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
        // KTrace has no place for printed text; a comment keeps it readable and KIELER skips it.
        const printed = trace.printed?.[index] ?? []
        const comment = printed.length > 0 ? ` // printed ${printed.map((text) => JSON.stringify(text)).join(' ')}` : ''
        lines.push(`${line};${comment}`)
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
export function readKTrace(text: string): TraceRecord {
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
