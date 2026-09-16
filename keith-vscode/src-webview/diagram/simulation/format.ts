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

export type NumberFormat = 'dec' | 'hex' | 'bin' | 'char'

export const NUMBER_FORMATS: { id: NumberFormat; label: string; title: string }[] = [
    { id: 'dec', label: 'dec', title: 'decimal' },
    { id: 'hex', label: 'hex', title: 'hexadecimal, e.g. 0x1F' },
    { id: 'bin', label: 'bin', title: 'binary, e.g. 0b11111' },
    { id: 'char', label: 'chr', title: "character with that code, e.g. 65 as 'A'" },
]

export function isNumberFormat(value: unknown): value is NumberFormat {
    return NUMBER_FORMATS.some((format) => format.id === value)
}

export function nextFormat(format: NumberFormat): NumberFormat {
    const index = NUMBER_FORMATS.findIndex((entry) => entry.id === format)
    return NUMBER_FORMATS[(index + 1) % NUMBER_FORMATS.length].id
}

export function describeFormat(format: NumberFormat): { label: string; title: string } {
    return NUMBER_FORMATS.find((entry) => entry.id === format) ?? NUMBER_FORMATS[0]
}

const MAX_CODE_POINT = 0x10ffff

/** Integers follow the chosen format; anything else stays decimal so a float never gets mangled. */
export function formatNumber(value: number, format: NumberFormat): string {
    if (!Number.isInteger(value) || format === 'dec') {
        return String(value)
    }
    const sign = value < 0 ? '-' : ''
    const magnitude = Math.abs(value)
    switch (format) {
        case 'hex':
            return `${sign}0x${magnitude.toString(16).toUpperCase()}`
        case 'bin':
            return `${sign}0b${magnitude.toString(2)}`
        case 'char':
            if (value < 0 || value > MAX_CODE_POINT) {
                return String(value)
            }
            return `'${printable(value)}'`
        default:
            return String(value)
    }
}

function printable(code: number): string {
    // Control characters have no glyph; show them as escapes rather than an invisible cell.
    if (code === 0x0a) return '\\n'
    if (code === 0x09) return '\\t'
    if (code === 0x0d) return '\\r'
    if (code === 0x00) return '\\0'
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return `\\x${code.toString(16).padStart(2, '0')}`
    return String.fromCodePoint(code)
}

/**
 * Reads a number the way a student would type it: `0x`/`0b` prefixes and quoted characters are
 * always accepted, and a bare digit string is read in the variable's format. Undefined when it is
 * not a number.
 */
export function parseNumber(text: string, format: NumberFormat = 'dec'): number | undefined {
    const trimmed = text.trim()
    if (trimmed === '') {
        return undefined
    }
    const quoted = trimmed.match(/^'(.+)'$/s) ?? trimmed.match(/^"(.+)"$/s)
    if (quoted) {
        return codePointOf(quoted[1])
    }
    const prefixed = trimmed.match(/^(-?)0([xXbB])([0-9a-fA-F]+)$/)
    if (prefixed) {
        // parseInt would stop at the first bad digit, so the digits are checked for the radix first.
        const hex = prefixed[2].toLowerCase() === 'x'
        return radixOrUndefined(`${prefixed[1]}${prefixed[3]}`, hex ? 16 : 2, hex ? /^-?[0-9a-fA-F]+$/ : /^-?[01]+$/)
    }
    switch (format) {
        case 'hex':
            return radixOrUndefined(trimmed, 16, /^-?[0-9a-fA-F]+$/) ?? finiteOrUndefined(trimmed)
        case 'bin':
            return radixOrUndefined(trimmed, 2, /^-?[01]+$/) ?? finiteOrUndefined(trimmed)
        case 'char':
            // A single character means its code; digits still mean a decimal number.
            return finiteOrUndefined(trimmed) ?? codePointOf(trimmed)
        default:
            return finiteOrUndefined(trimmed)
    }
}

/** Decimal numbers only; floats and exponents pass, Infinity and NaN do not. */
function finiteOrUndefined(text: string): number | undefined {
    if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text)) {
        return undefined
    }
    const value = Number(text)
    return Number.isFinite(value) ? value : undefined
}

function radixOrUndefined(text: string, radix: number, pattern: RegExp): number | undefined {
    if (!pattern.test(text)) {
        return undefined
    }
    const negative = text.startsWith('-')
    const parsed = parseInt(negative ? text.slice(1) : text, radix)
    return Number.isNaN(parsed) ? undefined : negative ? -parsed : parsed
}

function codePointOf(text: string): number | undefined {
    const unescaped = { '\\n': 0x0a, '\\t': 0x09, '\\r': 0x0d, '\\0': 0x00 }[text]
    if (unescaped !== undefined) {
        return unescaped
    }
    const hex = text.match(/^\\x([0-9a-fA-F]{2})$/)
    if (hex) {
        return parseInt(hex[1], 16)
    }
    const codePoints = Array.from(text)
    return codePoints.length === 1 ? codePoints[0].codePointAt(0) : undefined
}

const TEXT_ESCAPES: Record<string, string> = { '\\': '\\', n: '\n', r: '\r', t: '\t', '0': '\0' }

/**
 * Renders a string so that every character survives a single-line text field, which cannot hold a
 * newline at all. Backslashes and control characters use the same escapes as the `char` format.
 */
export function escapeText(value: string): string {
    return Array.from(value)
        .map((char) => (char === '\\' ? '\\\\' : printable(char.codePointAt(0) ?? 0)))
        .join('')
}

/** Inverse of {@link escapeText}. An unrecognised escape stays the literal characters that were typed. */
export function unescapeText(text: string): string {
    return text.replace(/\\(x[0-9a-fA-F]{2}|[\s\S])/g, (match, escape: string) =>
        escape.length === 3 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : TEXT_ESCAPES[escape] ?? match
    )
}
