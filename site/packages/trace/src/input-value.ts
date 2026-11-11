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

/** Reject values that cannot be represented by the existing simulation input. */
export function isCompatibleInput(value: unknown, current: unknown): boolean {
    if (typeof current === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (current === null) return value === null
    if (Array.isArray(current)) {
        return (
            Array.isArray(value) &&
            value.length === current.length &&
            value.every((entry, index) => isCompatibleInput(entry, current[index]))
        )
    }
    if (typeof current === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const expected = current as Record<string, unknown>
        const actual = value as Record<string, unknown>
        return (
            Object.keys(actual).length === Object.keys(expected).length &&
            Object.keys(expected).every(
                (key) =>
                    Object.prototype.hasOwnProperty.call(actual, key) && isCompatibleInput(actual[key], expected[key])
            )
        )
    }
    return current !== undefined && typeof value === typeof current
}
