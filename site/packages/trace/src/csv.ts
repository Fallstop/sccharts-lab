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
import {
    carryForward,
    decodeText,
    formatTraceValue,
    givenTimes,
    printedOf,
    TraceFileError,
    traceTimes,
    typeOfValue,
    VariableList,
} from './trace-record'
import type { TraceRecord } from './trace-record'

// CSV: a row per tick, for spreadsheets, pandas and R.

function csvCell(text: string): string {
    return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** A cell's text, where an empty string is quoted: an empty cell means the value is unknown. */
function csvValue(text: string, emptyString: boolean): string {
    return text === '' && emptyString ? '""' : csvCell(text)
}

/**
 * One row per tick: `tick`, `time` when the trace has a time delta, `printed` when the model
 * printed something, then a column per variable. Booleans are true/false, arrays JSON, a tick's
 * printed lines one cell with line breaks. pandas, R and spreadsheets read it as it is.
 */
export function writeCsv(trace: TraceRecord): string {
    const times = traceTimes(trace)
    const names = trace.variables.map((variable) => variable.name)
    const printed = printedOf(trace.printed)
    // A variable named like a bookkeeping column still gets that column first, so it is read back as itself.
    const timeColumn = !!times || names.includes('time')
    const printedColumn = !!printed || names.includes('printed')
    const header = ['tick', ...(timeColumn ? ['time'] : []), ...(printedColumn ? ['printed'] : []), ...names]
    const rows = trace.ticks.map((tick, index) => {
        const lines = printed?.[index] ?? []
        return [
            String(index + 1),
            ...(timeColumn ? [times ? String(times[index]) : ''] : []),
            ...(printedColumn ? [csvValue(lines.join('\n'), lines.length > 0)] : []),
            ...names.map((name) => csvValue(formatTraceValue(tick[name]), tick[name] === '')),
        ].join(',')
    })
    return `${[header.map(csvCell).join(','), ...rows].join('\n')}\n`
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
 * Reads a CSV with a header row and one row per tick. `tick`, `time` and `printed` at the start
 * are bookkeeping, not variables. Empty cells keep the value from the row before, so a
 * hand-written input sequence only has to note the changes.
 */
export function readCsv(text: string): TraceRecord {
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
    const hasDelta = header.some((name) => isTimeDelta({ id: name, categories: [] }))
    const timeColumn = header.findIndex((name, index) => name === 'time' && index <= 1)
    let next = timeColumn >= 0 ? timeColumn + 1 : Number(header[0] === 'tick')
    const printedColumn = header[next] === 'printed' ? next++ : -1
    const skipped = header.map(
        (name, index) => index < next && (name === 'tick' || name === 'time' || name === 'printed')
    )
    const seen = new Set<string>()
    header.forEach((name, index) => {
        if (!name) throw new TraceFileError(`Column ${index + 1} has no name in the header row.`, rows[0].line)
        if (skipped[index]) return
        if (seen.has(name)) throw new TraceFileError(`The header names ${name} twice.`, rows[0].line)
        seen.add(name)
    })
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
    const printed =
        printedColumn < 0
            ? undefined
            : printedOf(
                  rows.slice(1).map(({ cells, quoted }) => {
                      const cell = cells[printedColumn] ?? ''
                      return cell === '' && !quoted[printedColumn] ? [] : cell.split(/\r?\n/)
                  })
              )
    return { variables: list.variables, ticks: carryForward(ticks, list.variables), times, printed }
}
