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

/* global document, HTMLElement, HTMLElementTagNameMap, Node */

import { NumberFormat, escapeText, formatNumber } from './format'
import { ICONS } from './icons'

type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | boolean | number | ((event: Event) => void) | undefined>

/**
 * Tiny element builder: `h('button.kv-btn', { title, onclick }, icon('play'), 'Run')`.
 * Keys starting with `on` become listeners, booleans toggle attributes, the rest are attributes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
    selector: K | `${K}.${string}`,
    attrs: Attrs = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const [tag, ...classes] = selector.split('.')
    const element = document.createElement(tag as K)
    if (classes.length > 0) {
        element.className = classes.join(' ')
    }
    Object.entries(attrs).forEach(([key, value]) => {
        if (value === undefined || value === false) {
            return
        }
        if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2), value)
        } else if (value === true) {
            element.setAttribute(key, '')
        } else {
            element.setAttribute(key, String(value))
        }
    })
    children.forEach((child) => {
        if (child === null || child === undefined || child === false) {
            return
        }
        element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    })
    return element
}

/** A VS Code codicon as inline SVG, so it renders without the icon font. */
export function icon(name: string, extraClass = ''): HTMLElement {
    const span = h('span', { class: `kv-icon ${extraClass}`.trim(), 'aria-hidden': 'true' })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'currentColor')
    svg.innerHTML = ICONS[name] ?? ''
    span.appendChild(svg)
    return span
}

export function replaceChildren(parent: HTMLElement, ...children: Child[]): void {
    while (parent.firstChild) {
        parent.removeChild(parent.firstChild)
    }
    children.forEach((child) => {
        if (child) {
            parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
        }
    })
}

/** Compact, readable rendering of a simulation value; integers follow the variable's format. */
export function formatValue(value: unknown, format: NumberFormat = 'dec'): string {
    if (value === undefined) {
        return '–'
    }
    if (typeof value === 'string') {
        // Escaped, so a newline reads as `\n` instead of collapsing into a space in a table cell.
        return escapeText(value)
    }
    if (typeof value === 'number') {
        return formatNumber(value, format)
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => formatValue(entry, format)).join(', ')}]`
    }
    return JSON.stringify(value)
}

export function sameValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}
