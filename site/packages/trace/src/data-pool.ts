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

// The part of keith-vscode's simulation/data-pool.ts that replaying uses.

/** Give unset strings an editable value without sending a default to the running model. */
export function inputValue(value: unknown, type?: string): unknown {
    if (type !== 'string') return value
    if (Array.isArray(value)) return value.map((entry) => inputValue(entry, type))
    return value ?? ''
}
