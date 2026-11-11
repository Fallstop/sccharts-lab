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

import {
    carryForward,
    decodeText,
    formatTraceValue,
    givenTimes,
    printedOf,
    TRACE_FORMAT_ID,
    TraceFileError,
    traceTimes,
    typeOfValue,
    VariableList,
} from './trace-record'
import type { TraceRecord, TraceRole } from './trace-record'

// This lab's XML trace.

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
 * `<input>`, `<output>`, `<local>` (or `<value>` for an unknown role) elements, and a `<printed>`
 * per line the model printed.
 */
export function writeXml(trace: TraceRecord): string {
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
        trace.printed?.[index]?.forEach((text) => lines.push(`    <printed>${xmlEscape(text)}</printed>`))
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

export function readXml(text: string): TraceRecord {
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
    const printed = elements.map((element) =>
        element.children.filter((child) => child.name === 'printed').map((child) => child.text)
    )
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
        printed: printedOf(printed),
    }
}
