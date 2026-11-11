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

import { readCsv, writeCsv } from './csv'
import { readJson, writeJson } from './json'
import { readKTrace, writeKTrace } from './ktrace'
import { TraceFileError, traceFormatOf } from './trace-record'
import type { TraceFormat, TraceRecord } from './trace-record'
import { readXml, writeXml } from './xml'

// Simulation traces as files: what Save writes, and what Replay and Compare read. KTrace is written
// the way KIELER writes it and loads in the official tools; CSV, JSON and XML hold every variable.

export {
    formatTraceValue,
    inputsOnly,
    printedOf,
    sameTraceValue,
    timeDeltaOf,
    TRACE_FORMAT_ID,
    TRACE_FORMATS,
    TraceFileError,
    traceFormatOf,
    traceTimes,
} from './trace-record'
export type { TraceFormat, TraceRecord, TraceRole, TraceVariable } from './trace-record'

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

/** The format itself, or the one a file name's extension names (`run.ktrace`, `a/b/Run.CSV`). */
function formatFrom(formatOrFileName: string): TraceFormat {
    const format = traceFormatOf(`.${formatOrFileName}`)
    if (!format) {
        throw new TraceFileError(`${formatOrFileName} is not a trace. Use a .ktrace, .csv, .json or .xml file.`)
    }
    return format
}

/** Reads a trace in `format`, or in the format a file name's extension names. */
export function readTrace(text: string, formatOrFileName: TraceFormat | string): TraceRecord {
    let trace: TraceRecord
    switch (formatFrom(formatOrFileName)) {
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
